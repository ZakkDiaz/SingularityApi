import { getAbilityDefaults } from './abilities.js';

const KEY_BINDINGS = {
    KeyW: { axis: 'z', value: -1 },
    ArrowUp: { axis: 'z', value: -1 },
    KeyS: { axis: 'z', value: 1 },
    ArrowDown: { axis: 'z', value: 1 },
    KeyA: { axis: 'x', value: -1 },
    ArrowLeft: { axis: 'x', value: -1 },
    KeyD: { axis: 'x', value: 1 },
    ArrowRight: { axis: 'x', value: 1 }
};

const NETWORK_SEND_INTERVAL_MS = 120;
const MIN_MOVEMENT_DELTA = 0.05;

export class Player {
    constructor(world, network) {
        this.world = world;
        this.network = network;
        this.playerId = null;
        this.position = { x: 0, y: 1.6, z: 0 };
        this.velocity = { x: 0, z: 0 };
        this.heading = 0;
        this.speed = 7;
        this.keys = new Map();
        this.lastUpdateTime = performance.now();
        this.lastSentTime = 0;
        this.lastSentSnapshot = { x: 0, y: 1.6, z: 0, heading: 0 };

        this.abilities = new Map();
        this.abilityRanges = new Map();
        this.primaryAbilityId = null;
        this.debugInfo = this.createDebugInfo();
        this.stats = { attackSpeed: 1, unspentStatPoints: 0 };

        this.initInputListeners();
    }

    initInputListeners() {
        window.addEventListener('keydown', (evt) => {
            const binding = KEY_BINDINGS[evt.code];
            if (binding) {
                evt.preventDefault();
                this.keys.set(binding.axis, binding.value);
            }
        });

        window.addEventListener('keyup', (evt) => {
            const binding = KEY_BINDINGS[evt.code];
            if (binding) {
                this.keys.delete(binding.axis);
            }
        });
    }

    setPlayerId(id) {
        this.playerId = id;
    }

    update() {
        const now = performance.now();
        const delta = Math.min((now - this.lastUpdateTime) / 1000, 0.05);
        this.lastUpdateTime = now;

        const moveX = this.keys.get('x') ?? 0;
        const moveZ = this.keys.get('z') ?? 0;
        const magnitude = Math.hypot(moveX, moveZ);

        if (magnitude > 0) {
            const normX = moveX / magnitude;
            const normZ = moveZ / magnitude;
            this.velocity.x = normX * this.speed;
            this.velocity.z = normZ * this.speed;
            this.heading = Math.atan2(this.velocity.x, this.velocity.z);
        } else {
            this.velocity.x = 0;
            this.velocity.z = 0;
        }

        this.position.x += this.velocity.x * delta;
        this.position.z += this.velocity.z * delta;

        this.world.updateLocalPlayer(this.position.x, this.position.z, this.heading);
        this.updateAbilityCooldowns(now);
        this.tryAutoAbilities(now);
    }

    tryAutoAbilities(now) {
        const nearest = this.world.findNearestMob(this.position, Infinity);
        const debugBase = {
            nearestMobId: nearest?.id ?? null,
            nearestDistance: nearest?.distance ?? null
        };

        let debugInfo = this.createDebugInfo(debugBase);
        const networkReady = this.network && typeof this.network.isOpen === 'function' && this.network.isOpen();

        const abilityEntries = Array.from(this.abilities.values())
            .map(state => {
                const defaults = getAbilityDefaults(state.id) ?? {};
                const autoCast = state.autoCast ?? defaults.autoCast ?? true;
                const range = this.abilityRanges.get(state.id) ?? defaults.range ?? 6;
                const priority = typeof state.priority === 'number'
                    ? state.priority
                    : (typeof defaults.priority === 'number' ? defaults.priority : 1);
                const slot = typeof state.slot === 'number'
                    ? state.slot
                    : (typeof defaults.weaponSlot === 'number' ? defaults.weaponSlot : null);
                return { state, defaults, autoCast, range, priority, slot };
            })
            .sort((a, b) => {
                const slotA = typeof a.slot === 'number' ? a.slot : 99;
                const slotB = typeof b.slot === 'number' ? b.slot : 99;
                if (slotA !== slotB) {
                    return slotA - slotB;
                }
                if (a.priority !== b.priority) {
                    return a.priority - b.priority;
                }
                return (b.range ?? 0) - (a.range ?? 0);
            });

        const firstAuto = abilityEntries.find(entry => entry.autoCast && entry.state.unlocked);
        this.primaryAbilityId = firstAuto?.state.id ?? null;

        let highlightTargetId = null;
        let triggeredDebug = null;

        for (const entry of abilityEntries) {
            const ability = entry.state;
            const defaults = entry.defaults;
            const autoCast = entry.autoCast;
            const range = entry.range;

            if (autoCast && !debugInfo.abilityId) {
                debugInfo.abilityId = ability.id;
                debugInfo.abilityName = ability.name ?? defaults.name ?? ability.id;
                debugInfo.abilityRange = range;
            }

            const targetInRange = nearest && nearest.distance <= range ? nearest : null;
            if (autoCast && targetInRange && !debugInfo.targetId) {
                debugInfo.targetId = targetInRange.id;
                debugInfo.targetDistance = targetInRange.distance;
            }

            if (!autoCast || !ability.unlocked) {
                continue;
            }

            if (!ability.available || ability.pending || !networkReady) {
                continue;
            }

            if (!targetInRange) {
                continue;
            }

            let fallbackCooldown = defaults.cooldown ?? 1.5;
            if (defaults.scalesWithAttackSpeed) {
                const attackSpeed = Math.max(0.1, this.stats?.attackSpeed ?? 1);
                fallbackCooldown = fallbackCooldown / attackSpeed;
            }

            this.network.sendAbilityUse(ability.id, targetInRange.id);

            ability.pending = true;
            ability.available = false;
            ability.cooldownExpiresAt = now + fallbackCooldown * 1000;

            if (!triggeredDebug) {
                triggeredDebug = {
                    abilityId: ability.id,
                    abilityName: ability.name ?? defaults.name ?? ability.id,
                    abilityRange: range,
                    targetId: targetInRange.id,
                    targetDistance: targetInRange.distance
                };
            }

            if (!highlightTargetId) {
                highlightTargetId = targetInRange.id;
            }
        }

        if (triggeredDebug) {
            debugInfo = this.createDebugInfo({
                nearestMobId: nearest?.id ?? null,
                nearestDistance: nearest?.distance ?? null,
                ...triggeredDebug
            });
        } else if (!debugInfo.abilityId && this.primaryAbilityId) {
            const defaults = getAbilityDefaults(this.primaryAbilityId) ?? {};
            debugInfo.abilityId = this.primaryAbilityId;
            debugInfo.abilityName = defaults.name ?? this.primaryAbilityId;
            debugInfo.abilityRange = this.abilityRanges.get(this.primaryAbilityId) ?? defaults.range ?? null;
        }

        if (highlightTargetId) {
            this.world.setHighlightedMob(highlightTargetId);
        }

        this.debugInfo = debugInfo;
    }

    setStats(stats = {}) {
        const attackSpeed = typeof stats.attackSpeed === 'number' ? stats.attackSpeed : (this.stats?.attackSpeed ?? 1);
        const unspent = typeof stats.unspentStatPoints === 'number' ? stats.unspentStatPoints : (this.stats?.unspentStatPoints ?? 0);
        this.stats = {
            attackSpeed,
            unspentStatPoints: unspent
        };
    }

    sendMovementToServerIfNeeded() {
        const now = performance.now();
        if (now - this.lastSentTime < NETWORK_SEND_INTERVAL_MS) {
            return;
        }

        const dx = Math.abs(this.position.x - this.lastSentSnapshot.x);
        const dz = Math.abs(this.position.z - this.lastSentSnapshot.z);
        const headingDelta = Math.abs(this.heading - this.lastSentSnapshot.heading);
        if (dx < MIN_MOVEMENT_DELTA && dz < MIN_MOVEMENT_DELTA && headingDelta < 0.05 && now - this.lastSentTime < 400) {
            return;
        }

        if (!this.network || typeof this.network.sendPlayerTransform !== 'function') {
            return;
        }

        this.network.sendPlayerTransform({
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
            heading: this.heading,
            velocityX: this.velocity.x,
            velocityZ: this.velocity.z
        });

        this.lastSentTime = now;
        this.lastSentSnapshot = {
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
            heading: this.heading
        };
    }

    applyAuthoritativeState(snapshot) {
        if (!snapshot) {
            return;
        }
        this.position.x = snapshot.x ?? this.position.x;
        this.position.z = snapshot.z ?? this.position.z;
        this.heading = snapshot.heading ?? this.heading;
        this.world.updateLocalPlayer(this.position.x, this.position.z, this.heading);
    }

    setAbilitySnapshots(snapshots = []) {
        const now = performance.now();
        this.primaryAbilityId = null;
        const seenIds = new Set();
        snapshots.forEach(snapshot => {
            const id = snapshot.abilityId ?? snapshot.id;
            if (!id) {
                return;
            }
            const defaults = getAbilityDefaults(id) ?? {};
            const range = typeof snapshot.range === 'number'
                ? snapshot.range
                : (defaults.range ?? this.abilityRanges.get(id) ?? 6);
            this.abilityRanges.set(id, range);

            const autoCast = snapshot.autoCast ?? defaults.autoCast ?? true;
            const priority = typeof snapshot.priority === 'number'
                ? snapshot.priority
                : (typeof defaults.priority === 'number' ? defaults.priority : 1);
            const weaponSlot = typeof snapshot.weaponSlot === 'number'
                ? snapshot.weaponSlot
                : (typeof defaults.weaponSlot === 'number' ? defaults.weaponSlot : null);
            const abilityState = {
                id,
                name: snapshot.name ?? defaults.name ?? id,
                key: snapshot.key ?? defaults.key ?? '',
                unlocked: snapshot.unlocked ?? Boolean(defaults.unlocked),
                available: snapshot.available ?? false,
                pending: false,
                cooldownExpiresAt: now + Math.max(0, snapshot.cooldownSeconds ?? 0) * 1000,
                autoCast,
                range,
                priority,
                slot: weaponSlot
            };

            if (abilityState.available) {
                abilityState.cooldownExpiresAt = now;
            }

            this.abilities.set(id, abilityState);
            seenIds.add(id);
        });

        Array.from(this.abilities.keys()).forEach(id => {
            if (!seenIds.has(id)) {
                this.abilities.delete(id);
                this.abilityRanges.delete(id);
            }
        });

        const sortedAuto = Array.from(this.abilities.values())
            .filter(state => state.autoCast)
            .sort((a, b) => {
                const slotA = typeof a.slot === 'number' ? a.slot : 99;
                const slotB = typeof b.slot === 'number' ? b.slot : 99;
                if (slotA !== slotB) {
                    return slotA - slotB;
                }
                return (a.priority ?? 1) - (b.priority ?? 1);
            });
        this.primaryAbilityId = sortedAuto.length > 0 ? sortedAuto[0].id : null;
    }

    getAbilityStates() {
        const now = performance.now();
        this.updateAbilityCooldowns(now);
        return Array.from(this.abilities.values()).map(state => {
            const remaining = Math.max(0, (state.cooldownExpiresAt - now) / 1000);
            return {
                ...state,
                cooldownRemaining: remaining,
                ready: state.unlocked && state.available && !state.pending
            };
        });
    }

    getPosition() {
        return { x: this.position.x, z: this.position.z };
    }

    updateAbilityCooldowns(now) {
        for (const ability of this.abilities.values()) {
            if (!ability.unlocked) {
                continue;
            }
            if (ability.cooldownExpiresAt && ability.cooldownExpiresAt <= now) {
                ability.pending = false;
                ability.available = true;
            }
        }
    }

    createDebugInfo(overrides = {}) {
        return {
            abilityId: null,
            abilityName: '',
            abilityRange: null,
            targetId: null,
            targetDistance: null,
            nearestMobId: null,
            nearestDistance: null,
            ...overrides
        };
    }

    getDebugSnapshot() {
        return { ...this.debugInfo };
    }
}
