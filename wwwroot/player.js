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
        this.autoAbilityId = 'autoAttack';
        this.abilityRanges = new Map();

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
        this.tryAutoAbility(now);
    }

    tryAutoAbility(now) {
        const ability = this.abilities.get(this.autoAbilityId);
        if (!ability || !ability.unlocked || ability.pending || !ability.available) {
            return;
        }

        if (!this.network || typeof this.network.isOpen !== 'function' || !this.network.isOpen()) {
            return;
        }

        const range = this.abilityRanges.get(this.autoAbilityId) ?? 6;
        const target = this.world.findNearestMob(this.position, range);
        if (!target) {
            return;
        }

        const defaults = getAbilityDefaults(ability.id) ?? {};
        const fallbackCooldown = defaults.cooldown ?? 1.5;

        this.network.sendAbilityUse(ability.id, target.id);
        ability.pending = true;
        ability.available = false;
        ability.cooldownExpiresAt = now + fallbackCooldown * 1000;
        this.world.setHighlightedMob(target.id);
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
        snapshots.forEach(snapshot => {
            const id = snapshot.abilityId ?? snapshot.id;
            if (!id) {
                return;
            }
            const defaults = getAbilityDefaults(id) ?? {};
            this.autoAbilityId = this.autoAbilityId || id;
            this.abilityRanges.set(id, defaults.range ?? this.abilityRanges.get(id) ?? 6);
            const abilityState = {
                id,
                name: snapshot.name ?? defaults.name ?? id,
                key: snapshot.key ?? defaults.key ?? '',
                unlocked: snapshot.unlocked ?? Boolean(defaults.unlocked),
                available: snapshot.available ?? false,
                pending: false,
                cooldownExpiresAt: now + Math.max(0, snapshot.cooldownSeconds ?? 0) * 1000
            };
            if (abilityState.available) {
                abilityState.cooldownExpiresAt = now;
            }
            this.abilities.set(id, abilityState);
        });

        const primary = [...this.abilities.values()].find(a => (a.key ?? '') === '1' || a.id === 'autoAttack');
        if (primary) {
            this.autoAbilityId = primary.id;
        }
    }

    getAbilityStates() {
        const now = performance.now();
        return Array.from(this.abilities.values()).map(state => {
            const remaining = Math.max(0, (state.cooldownExpiresAt - now) / 1000);
            return {
                ...state,
                cooldownRemaining: remaining,
                ready: state.unlocked && !state.pending && (state.available || remaining <= 0.05)
            };
        });
    }

    getPosition() {
        return { x: this.position.x, z: this.position.z };
    }
}
