import { getAbilityDefaults } from './abilities.js';
import { PLAYER_HEIGHT_OFFSET } from './world.js';

const KEY_BINDINGS = {
    KeyW: { axis: 'forward', value: 1 },
    ArrowUp: { axis: 'forward', value: 1 },
    KeyS: { axis: 'forward', value: -1 },
    ArrowDown: { axis: 'forward', value: -1 },
    KeyQ: { axis: 'strafe', value: -1 },
    KeyE: { axis: 'strafe', value: 1 },
    KeyA: { axis: 'turn', value: -1 },
    ArrowLeft: { axis: 'turn', value: -1 },
    KeyD: { axis: 'turn', value: 1 },
    ArrowRight: { axis: 'turn', value: 1 }
};

const TURN_SPEED_RADIANS = 2.6;
const DEFAULT_MAX_STEP_HEIGHT = 12;
const TWO_PI = Math.PI * 2;

function normalizeAngle(angle) {
    if (!Number.isFinite(angle)) {
        return 0;
    }
    let normalized = angle % TWO_PI;
    if (normalized <= -Math.PI) {
        normalized += TWO_PI;
    } else if (normalized > Math.PI) {
        normalized -= TWO_PI;
    }
    return normalized;
}

const NETWORK_SEND_INTERVAL_MS = 120;
const MIN_MOVEMENT_DELTA = 0.05;

export class Player {
    constructor(world, network) {
        this.world = world;
        this.network = network;
        this.playerId = null;
        this.position = { x: 0, y: PLAYER_HEIGHT_OFFSET, z: 0 };
        this.velocity = { x: 0, z: 0 };
        this.heading = 0;
        this.baseMoveSpeed = 12;
        this.moveSpeed = this.baseMoveSpeed;
        this.verticalVelocity = 0;
        this.jumpVelocity = 16;
        this.gravity = -36;
        this.isGrounded = true;
        this.jumpRequested = false;
        this.isEthereal = false;
        this.menuStates = new Map();
        this.activeBindings = new Map();
        this.lastUpdateTime = performance.now();
        this.lastSentTime = 0;
        this.lastSentSnapshot = { x: 0, y: PLAYER_HEIGHT_OFFSET, z: 0, heading: 0 };

        this.abilities = new Map();
        this.abilityRanges = new Map();
        this.primaryAbilityId = null;
        this.debugInfo = this.createDebugInfo();
        this.stats = { attackSpeed: 1, moveSpeed: this.baseMoveSpeed, unspentStatPoints: 0, isEthereal: false };
        this.turnSpeed = TURN_SPEED_RADIANS;
        this.maxStepHeight = Math.max(0.1, this.world?.getMaxStepHeight?.() ?? DEFAULT_MAX_STEP_HEIGHT);

        this.initInputListeners();
        this.world.setHeadingListener?.((heading) => this.setHeadingFromCamera(heading));
        const initialGround = this.world.getGroundHeight(0, 0) + PLAYER_HEIGHT_OFFSET;
        this.position.y = initialGround;
        this.lastSentSnapshot = { x: this.position.x, y: this.position.y, z: this.position.z, heading: this.heading };
        this.world.updateLocalPlayer({ x: this.position.x, y: this.position.y, z: this.position.z, heading: this.heading });
    }

    initInputListeners() {
        window.addEventListener('keydown', (evt) => {
            if (evt.code === 'Space') {
                evt.preventDefault();
                this.jumpRequested = true;
                return;
            }
            const binding = KEY_BINDINGS[evt.code];
            if (binding) {
                evt.preventDefault();
                if (evt.repeat && this.activeBindings.has(evt.code)) {
                    return;
                }
                this.activeBindings.set(evt.code, binding);
            }
        });

        window.addEventListener('keyup', (evt) => {
            if (evt.code === 'Space') {
                this.jumpRequested = false;
                return;
            }
            const binding = KEY_BINDINGS[evt.code];
            if (binding) {
                this.activeBindings.delete(evt.code);
            }
        });
    }

    setMenuState(id, isOpen) {
        if (!id) {
            return;
        }
        if (isOpen) {
            this.menuStates.set(id, true);
        } else {
            this.menuStates.delete(id);
        }
        this.updateControlSuspension();
    }

    updateControlSuspension() {
        const menuOpen = this.menuStates.size > 0;
        const shouldSuspend = menuOpen || this.isEthereal;
        if (typeof this.world?.setControlSuspended === 'function') {
            this.world.setControlSuspended(shouldSuspend);
        }
    }

    setPlayerId(id) {
        this.playerId = id;
    }

    getAxisValue(axis) {
        let value = 0;
        for (const binding of this.activeBindings.values()) {
            if (binding.axis === axis) {
                value += binding.value;
            }
        }
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.max(-1, Math.min(1, value));
    }

    update() {
        const now = performance.now();
        const delta = Math.min((now - this.lastUpdateTime) / 1000, 0.05);
        this.lastUpdateTime = now;
        const startX = this.position.x;
        const startZ = this.position.z;

        if (this.isEthereal) {
            this.jumpRequested = false;
        } else {
            const stepFromWorld = this.world?.getMaxStepHeight?.();
            if (typeof stepFromWorld === 'number' && Number.isFinite(stepFromWorld) && stepFromWorld > 0) {
                this.maxStepHeight = stepFromWorld;
            }

            const turnInput = this.getAxisValue('turn');
            if (turnInput !== 0 && delta > 0) {
                this.heading = normalizeAngle(this.heading + turnInput * this.turnSpeed * delta);
                this.world.setCameraYaw?.(this.heading);
            }

            const forwardInput = this.getAxisValue('forward');
            const strafeInput = this.getAxisValue('strafe');
            let desiredVelX = 0;
            let desiredVelZ = 0;
            const magnitude = Math.hypot(strafeInput, forwardInput);

            if (magnitude > 0) {
                const normForward = forwardInput / magnitude;
                const normStrafe = strafeInput / magnitude;
                const yaw = this.heading;
                const sinYaw = Math.sin(yaw);
                const cosYaw = Math.cos(yaw);
                const forwardX = sinYaw;
                const forwardZ = cosYaw;
                const rightX = cosYaw;
                const rightZ = -sinYaw;
                const moveSpeed = Math.max(0.1, this.moveSpeed ?? this.baseMoveSpeed);
                const dirX = forwardX * normForward + rightX * normStrafe;
                const dirZ = forwardZ * normForward + rightZ * normStrafe;
                desiredVelX = dirX * moveSpeed;
                desiredVelZ = dirZ * moveSpeed;
            }

            const resolved = this.resolveMovement(desiredVelX, desiredVelZ, delta);
            this.position.x = resolved.x;
            this.position.z = resolved.z;
        }

        if (this.isEthereal) {
            this.verticalVelocity = 0;
        } else {
            if (this.jumpRequested && this.isGrounded) {
                this.verticalVelocity = this.jumpVelocity;
                this.isGrounded = false;
                this.jumpRequested = false;
            }

            this.verticalVelocity += this.gravity * delta;
            this.position.y += this.verticalVelocity * delta;
        }

        const groundY = this.world.getGroundHeight(this.position.x, this.position.z) + PLAYER_HEIGHT_OFFSET;
        if (this.isEthereal) {
            this.position.y = groundY;
            this.verticalVelocity = 0;
            this.isGrounded = true;
        } else if (this.position.y <= groundY) {
            this.position.y = groundY;
            if (this.verticalVelocity < 0) {
                this.verticalVelocity = 0;
            }
            this.isGrounded = true;
        } else {
            this.isGrounded = false;
        }

        const deltaX = this.position.x - startX;
        const deltaZ = this.position.z - startZ;
        if (this.isEthereal || delta <= 0) {
            this.velocity.x = 0;
            this.velocity.z = 0;
        } else {
            const velX = deltaX / delta;
            const velZ = deltaZ / delta;
            this.velocity.x = Number.isFinite(velX) ? velX : 0;
            this.velocity.z = Number.isFinite(velZ) ? velZ : 0;
        }

        this.world.updateLocalPlayer({
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
            heading: this.heading
        });
        this.updateAbilityCooldowns(now);
        this.tryAutoAbilities(now);
    }

    resolveMovement(desiredVelX, desiredVelZ, delta) {
        const startX = this.position.x;
        const startZ = this.position.z;
        if (!this.world || typeof this.world.getGroundHeight !== 'function' || delta <= 0) {
            return {
                x: startX + (Number.isFinite(desiredVelX) ? desiredVelX : 0) * delta,
                z: startZ + (Number.isFinite(desiredVelZ) ? desiredVelZ : 0) * delta
            };
        }

        const velX = Number.isFinite(desiredVelX) ? desiredVelX : 0;
        const velZ = Number.isFinite(desiredVelZ) ? desiredVelZ : 0;
        const dx = velX * delta;
        const dz = velZ * delta;

        if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) {
            return { x: startX, z: startZ };
        }

        const currentGround = this.world.getGroundHeight(startX, startZ);
        const candidateX = startX + dx;
        const candidateZ = startZ + dz;
        const candidateGround = this.world.getGroundHeight(candidateX, candidateZ);

        if (Math.abs(candidateGround - currentGround) <= this.maxStepHeight) {
            return { x: candidateX, z: candidateZ };
        }

        return this.resolveTerrainStep(startX, startZ, dx, dz, currentGround);
    }

    resolveTerrainStep(startX, startZ, dx, dz, currentGround) {
        if (!this.world || typeof this.world.getGroundHeight !== 'function') {
            return { x: startX, z: startZ };
        }

        const distance = Math.hypot(dx, dz);
        if (distance <= 1e-6) {
            return { x: startX, z: startZ };
        }

        let low = 0;
        let high = 1;
        let best = 0;
        for (let i = 0; i < 6; i++) {
            const mid = (low + high) * 0.5;
            const testX = startX + dx * mid;
            const testZ = startZ + dz * mid;
            const testGround = this.world.getGroundHeight(testX, testZ);
            if (Math.abs(testGround - currentGround) <= this.maxStepHeight) {
                best = mid;
                low = mid;
            } else {
                high = mid;
            }
        }

        if (best <= 0.001) {
            return { x: startX, z: startZ };
        }

        const finalX = startX + dx * best;
        const finalZ = startZ + dz * best;
        const finalGround = this.world.getGroundHeight(finalX, finalZ);
        if (Math.abs(finalGround - currentGround) > this.maxStepHeight + 0.01) {
            return { x: startX, z: startZ };
        }

        return { x: finalX, z: finalZ };
    }

    setHeadingFromCamera(heading) {
        this.heading = normalizeAngle(heading);
        this.world.setCameraYaw?.(this.heading);
    }

    tryAutoAbilities(now) {
        if (this.isEthereal) {
            this.world.setHighlightedMob(null);
            this.debugInfo = this.createDebugInfo();
            return;
        }
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
        const moveSpeed = typeof stats.moveSpeed === 'number' ? stats.moveSpeed : (this.stats?.moveSpeed ?? this.baseMoveSpeed);
        const isEthereal = Boolean(stats.isEthereal ?? stats.ethereal ?? false);
        this.moveSpeed = moveSpeed;
        this.stats = {
            attackSpeed,
            moveSpeed,
            unspentStatPoints: unspent,
            isEthereal
        };
        if (this.isEthereal !== isEthereal) {
            this.isEthereal = isEthereal;
            this.updateControlSuspension();
        } else {
            this.isEthereal = isEthereal;
        }
    }

    sendMovementToServerIfNeeded() {
        const now = performance.now();
        if (this.isEthereal) {
            return;
        }
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
            velocityY: this.verticalVelocity,
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
        this.position.y = typeof snapshot.y === 'number' ? snapshot.y : this.position.y;
        this.position.z = snapshot.z ?? this.position.z;
        if (typeof snapshot.heading === 'number') {
            this.heading = snapshot.heading;
            this.world.setCameraYaw?.(this.heading);
        }
        this.lastSentSnapshot = {
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
            heading: this.heading
        };
        this.world.updateLocalPlayer({
            x: this.position.x,
            y: this.position.y,
            z: this.position.z,
            heading: this.heading
        });
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
