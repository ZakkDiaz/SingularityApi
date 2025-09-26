import { log } from './utils.js';
import { createPlayerAvatar, updateHumanoidAnimation, triggerHumanoidAttack } from './avatars.js';

const FORWARD_KEYS = new Set(['w', 'ArrowUp']);
const BACKWARD_KEYS = new Set(['s', 'ArrowDown']);
const LEFT_KEYS = new Set(['a', 'ArrowLeft']);
const RIGHT_KEYS = new Set(['d', 'ArrowRight']);

export class Player {
    constructor(world, network, onPointerAcquired) {
        this.world = world;
        this.scene = world.scene;
        this.camera = world.camera;
        this.network = network;
        this.onPointerAcquired = onPointerAcquired;

        this.playerId = null;
        this.pos = new THREE.Vector3(0, 12, 0);
        this.vel = new THREE.Vector3();
        this.heading = 0;
        this.cameraPitch = -0.25;
        this.cameraDistance = 6.5;
        this.cameraHeight = 2.0;

        this.maxGroundSpeed = 6.5; // units per second
        this.sprintMultiplier = 1.7;
        this.groundAccel = 24.0;
        this.groundDeaccel = 16.0;
        this.airAccel = 6.0;
        this.jumpForce = 6.0;
        this.gravity = -18.0;
        this.lookSensitivity = 0.0028;

        this.inAir = true;
        this.keys = {
            forward: false,
            backward: false,
            left: false,
            right: false,
            jump: false,
            sprint: false
        };

        this.pendingInteraction = false;
        this.interactCooldown = 0;
        this.jumpRequested = false;

        this.abilities = new Map();
        this.abilityKeyMap = new Map();

        this.chunkSize = 16;
        this.loadRadius = 2;
        this.lastChunkX = null;
        this.lastChunkZ = null;

        this.lastSentPosition = this.pos.clone();
        this.lastSentHeading = this.heading;
        this.lastNetworkSend = 0;

        this.pointerLocked = false;
        this.lastUpdateTime = performance.now();

        this.mesh = createPlayerAvatar();
        this.mesh.position.copy(this.pos);
        this.scene.add(this.mesh);
        if (this.world && typeof this.world.registerLocalPlayerAvatar === 'function') {
            this.world.registerLocalPlayerAvatar(this.mesh);
        }

        this.avatarState = { moveSpeed: 0 };

        this.aimDirection = new THREE.Vector3(0, 0, -1);
        this.aimOrigin = new THREE.Vector3();
        this.aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');

        this.initInputListeners();
    }

    initInputListeners() {
        window.addEventListener('keydown', (evt) => {
            if (evt.repeat) return;
            if (this.handleAbilityKeyDown(evt)) {
                evt.preventDefault();
                return;
            }
            if (FORWARD_KEYS.has(evt.key)) this.keys.forward = true;
            if (BACKWARD_KEYS.has(evt.key)) this.keys.backward = true;
            if (LEFT_KEYS.has(evt.key)) this.keys.left = true;
            if (RIGHT_KEYS.has(evt.key)) this.keys.right = true;
            if (evt.key === ' ') {
                this.keys.jump = true;
                this.jumpRequested = true;
            }
            if (evt.key === 'Shift') this.keys.sprint = true;
            if (evt.key && evt.key.toLowerCase() === 'e') this.pendingInteraction = true;
        });

        window.addEventListener('keyup', (evt) => {
            if (FORWARD_KEYS.has(evt.key)) this.keys.forward = false;
            if (BACKWARD_KEYS.has(evt.key)) this.keys.backward = false;
            if (LEFT_KEYS.has(evt.key)) this.keys.left = false;
            if (RIGHT_KEYS.has(evt.key)) this.keys.right = false;
            if (evt.key === ' ') {
                this.keys.jump = false;
                this.jumpRequested = false;
            }
            if (evt.key === 'Shift') this.keys.sprint = false;
        });

        document.body.addEventListener('click', () => {
            if (document.pointerLockElement !== document.body) {
                document.body.requestPointerLock();
            }
        });

        document.addEventListener('pointerlockchange', () => {
            this.pointerLocked = document.pointerLockElement === document.body;
            if (this.pointerLocked && this.onPointerAcquired) {
                this.onPointerAcquired();
            }
        });

        document.addEventListener('mousemove', (evt) => {
            if (!this.pointerLocked) return;
            this.heading -= evt.movementX * this.lookSensitivity;
            this.cameraPitch -= evt.movementY * this.lookSensitivity;
            const limit = Math.PI / 2 - 0.2;
            this.cameraPitch = THREE.MathUtils.clamp(this.cameraPitch, -limit, limit * 0.6);
        });
    }

    setPlayerId(id) {
        this.playerId = id;
    }

    setChunkSize(size) {
        if (!size) return;
        this.chunkSize = size;
    }

    getChunkSize() {
        return this.chunkSize;
    }

    update() {
        const now = performance.now();
        const delta = Math.min((now - this.lastUpdateTime) / 1000, 0.05);
        this.lastUpdateTime = now;

        this.applyMovement(delta);
        this.applyGravity(delta);
        this.integrate(delta);
        this.updateCamera();
        this.interactCooldown = Math.max(0, this.interactCooldown - delta);
        if (this.pendingInteraction && this.interactCooldown <= 0) {
            this.pendingInteraction = false;
            this.tryInteract();
            this.interactCooldown = 0.5;
        }
        this.checkChunkBoundary();
        this.updateAbilityCooldowns(delta);
        this.animateAvatar(delta);
    }

    applyMovement(delta) {
        const forward = (this.keys.forward ? 1 : 0) - (this.keys.backward ? 1 : 0);
        const strafe = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);
        const magnitude = Math.hypot(forward, strafe);

        let moveX = 0;
        let moveZ = 0;

        if (magnitude > 0) {
            const normForward = forward / magnitude;
            const normStrafe = strafe / magnitude;
            const headingSin = Math.sin(this.heading);
            const headingCos = Math.cos(this.heading);
            const forwardDirX = headingSin;
            const forwardDirZ = headingCos;
            const rightDirX = headingCos;
            const rightDirZ = -headingSin;
            moveX = forwardDirX * normForward + rightDirX * normStrafe;
            moveZ = forwardDirZ * normForward + rightDirZ * normStrafe;
        }

        const targetSpeed = this.maxGroundSpeed * (this.keys.sprint ? this.sprintMultiplier : 1);
        const desiredVx = moveX * targetSpeed;
        const desiredVz = moveZ * targetSpeed;

        const accel = this.inAir ? this.airAccel : this.groundAccel;
        const decel = this.inAir ? this.airAccel : this.groundDeaccel;

        this.vel.x = this.approach(this.vel.x, desiredVx, accel * delta, decel * delta);
        this.vel.z = this.approach(this.vel.z, desiredVz, accel * delta, decel * delta);

        if (this.avatarState) {
            this.avatarState.moveSpeed = Math.hypot(this.vel.x, this.vel.z);
        }

        if (!this.inAir) {
            const groundY = getGroundHeightRaycast(this.scene, this.pos.x, this.pos.z, 200, [this.mesh]);
            this.pos.y = groundY;
            if (this.jumpRequested) {
                this.vel.y = this.jumpForce;
                this.inAir = true;
                this.jumpRequested = false;
            }
        }
    }

    applyGravity(delta) {
        this.vel.y += this.gravity * delta;
    }

    integrate(delta) {
        const nextPos = this.pos.clone().addScaledVector(this.vel, delta);
        const groundY = getGroundHeightRaycast(this.scene, nextPos.x, nextPos.z, 200, [this.mesh]);

        if (nextPos.y <= groundY) {
            nextPos.y = groundY;
            this.vel.y = 0;
            this.inAir = false;
        } else {
            this.inAir = true;
        }

        this.pos.copy(nextPos);
        this.mesh.position.copy(this.pos);
        this.mesh.rotation.y = this.heading;
    }

    updateCamera() {
        const offset = new THREE.Vector3(0, 0, -this.cameraDistance);
        const rotation = new THREE.Euler(this.cameraPitch, this.heading, 0, 'YXZ');
        offset.applyEuler(rotation);

        this.camera.position.set(
            this.pos.x + offset.x,
            this.pos.y + this.cameraHeight + offset.y,
            this.pos.z + offset.z
        );
        this.camera.lookAt(this.pos.x, this.pos.y + this.cameraHeight, this.pos.z);
    }

    approach(current, target, accelRate, decelRate) {
        const diff = target - current;
        if (Math.abs(diff) < 1e-4) {
            return target;
        }
        if (diff > 0) {
            const next = current + accelRate;
            return next > target ? target : next;
        }
        const next = current - decelRate;
        return next < target ? target : next;
    }

    sendMovementToServerIfNeeded() {
        if (!this.network) {
            return;
        }

        const now = performance.now();
        const moved = this.pos.distanceToSquared(this.lastSentPosition) > 0.04;
        const headingChanged = Math.abs(this.heading - this.lastSentHeading) > 0.01;
        const timeElapsed = now - this.lastNetworkSend > 200;

        if (moved || headingChanged || timeElapsed) {
            this.network.sendPlayerTransform({
                x: this.pos.x,
                y: this.pos.y,
                z: this.pos.z,
                heading: this.heading,
                velocityX: this.vel.x,
                velocityZ: this.vel.z
            });
            this.lastSentPosition.copy(this.pos);
            this.lastSentHeading = this.heading;
            this.lastNetworkSend = now;
        }
    }

    applyAuthoritativeState(snapshot) {
        if (!snapshot) {
            return;
        }

        const serverPos = new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z);
        const distanceSq = serverPos.distanceToSquared(this.pos);

        if (distanceSq > 1.5) {
            this.pos.copy(serverPos);
        } else {
            this.pos.lerp(serverPos, 0.25);
        }

        this.heading = snapshot.heading ?? this.heading;
        this.mesh.position.copy(this.pos);
        this.mesh.rotation.y = this.heading;
        this.updateCamera();
    }

    tryInteract() {
        if (!this.network) {
            return;
        }
        const targetId = this.findCombatTarget();
        if (!targetId) {
            return;
        }
        this.network.sendInteraction(targetId);
    }

    findCombatTarget(maxDistance = 16) {
        const origin = this.camera.position.clone();
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
        const raycaster = new THREE.Raycaster(origin, direction, 0, maxDistance);
        const objects = this.scene.children.filter(obj => obj.userData && (obj.userData.combatId || obj.userData.environmentId));
        const intersects = raycaster.intersectObjects(objects, true);
        if (intersects.length === 0) {
            return null;
        }
        const match = intersects.find(hit => Boolean(getCombatTargetId(hit.object)));
        if (!match) {
            return null;
        }
        return getCombatTargetId(match.object) ?? null;
    }

    checkChunkBoundary() {
        const cx = Math.floor(this.pos.x / this.chunkSize);
        const cz = Math.floor(this.pos.z / this.chunkSize);

        if (cx !== this.lastChunkX || cz !== this.lastChunkZ) {
            this.lastChunkX = cx;
            this.lastChunkZ = cz;
            if (this.network) {
                this.network.requestNearbyChunks(this.loadRadius);
            }
        }
    }

    getPosition() {
        return { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    }

    handleAbilityKeyDown(evt) {
        if (!evt || typeof evt.key !== 'string') {
            return false;
        }
        const normalized = evt.key.toLowerCase();
        if (!this.abilityKeyMap.has(normalized)) {
            return false;
        }
        const abilityId = this.abilityKeyMap.get(normalized);
        const executed = this.tryUseAbility(abilityId);
        return executed || (abilityId ? this.abilities.has(abilityId) : false);
    }

    tryUseAbility(abilityId) {
        if (!abilityId || !this.network) {
            return false;
        }
        const ability = this.abilities.get(abilityId);
        if (!ability) {
            return false;
        }
        if (!ability.unlocked) {
            log(`${ability.name} is not learned yet.`);
            return false;
        }
        if ((ability.cooldownRemaining ?? 0) > 0.05) {
            log(`${ability.name} ready in ${ability.cooldownRemaining.toFixed(1)}s.`);
            return false;
        }
        const targetId = this.findCombatTarget();
        if (!targetId) {
            log('No valid target in sight.');
            return false;
        }
        this.network.sendAbilityUse(abilityId, targetId);
        if (typeof ability.cooldown === 'number') {
            ability.cooldownRemaining = ability.cooldown;
        }
        triggerHumanoidAttack(this.mesh);
        return true;
    }

    setAbilities(abilities) {
        if (!Array.isArray(abilities)) {
            return;
        }
        const seen = new Set();
        this.abilityKeyMap.clear();

        abilities.forEach(ability => {
            if (!ability || !ability.id) {
                return;
            }
            const id = ability.id;
            seen.add(id);
            const cooldown = typeof ability.cooldown === 'number' ? Math.max(0, ability.cooldown) : 0;
            const cooldownRemaining = typeof ability.cooldownRemaining === 'number'
                ? Math.max(0, ability.cooldownRemaining)
                : 0;
            const key = ability.key ? String(ability.key) : '';
            const normalizedKey = key ? key.toLowerCase() : '';
            const state = {
                id,
                name: ability.name || id,
                key,
                normalizedKey,
                cooldown,
                cooldownRemaining,
                unlocked: Boolean(ability.unlocked)
            };
            this.abilities.set(id, state);
            if (normalizedKey) {
                this.abilityKeyMap.set(normalizedKey, id);
            }
        });

        for (const id of [...this.abilities.keys()]) {
            if (!seen.has(id)) {
                this.abilities.delete(id);
            }
        }
    }

    updateAbilityCooldowns(delta) {
        if (!delta || this.abilities.size === 0) {
            return;
        }
        for (const ability of this.abilities.values()) {
            if (typeof ability.cooldownRemaining === 'number') {
                ability.cooldownRemaining = Math.max(0, ability.cooldownRemaining - delta);
            }
        }
    }

    animateAvatar(delta) {
        if (!this.mesh) {
            return;
        }
        const speed = this.avatarState?.moveSpeed ?? 0;
        if (this.aimEuler) {
            this.aimEuler.set(this.cameraPitch, this.heading, 0, 'YXZ');
            this.aimDirection.set(0, 0, -1).applyEuler(this.aimEuler).normalize();
        }
        this.aimOrigin.set(this.pos.x, this.pos.y + this.cameraHeight * 0.75, this.pos.z);
        updateHumanoidAnimation(this.mesh, delta, {
            speed,
            onGround: !this.inAir,
            aimDirection: this.aimDirection,
            aimOrigin: this.aimOrigin,
            aimStrength: 0.95
        });
    }

    getAbilityStates() {
        return Array.from(this.abilities.values()).map(ability => ({ ...ability }));
    }
}

function getGroundHeightRaycast(scene, x, z, maxHeight = 200, ignoreMeshes = []) {
    const origin = new THREE.Vector3(x, maxHeight, z);
    const dir = new THREE.Vector3(0, -1, 0);
    const raycaster = new THREE.Raycaster(origin, dir);
    const allMeshes = scene.children.filter(
        obj => !ignoreMeshes.includes(obj) && obj.userData && obj.userData.isTerrain
    );
    const intersects = raycaster.intersectObjects(allMeshes, true);
    if (intersects.length > 0) {
        return intersects[0].point.y;
    }
    return 0;
}

function getCombatTargetId(object) {
    let current = object;
    while (current) {
        if (current.userData) {
            if (current.userData.combatId) {
                return current.userData.combatId;
            }
            if (current.userData.environmentId) {
                return current.userData.environmentId;
            }
        }
        current = current.parent;
    }
    return null;
}
