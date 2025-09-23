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

        this.chunkSize = 16;
        this.loadRadius = 2;
        this.lastChunkX = null;
        this.lastChunkZ = null;

        this.lastSentPosition = this.pos.clone();
        this.lastSentHeading = this.heading;
        this.lastNetworkSend = 0;

        this.pointerLocked = false;
        this.lastUpdateTime = performance.now();

        this.mesh = this.buildLocalAvatar();
        this.mesh.position.copy(this.pos);
        this.scene.add(this.mesh);

        this.initInputListeners();
    }

    buildLocalAvatar() {
        const group = new THREE.Group();

        const bodyGeo = new THREE.CapsuleGeometry(0.36, 1.2, 12, 16);
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0xfca17d,
            roughness: 0.4,
            metalness: 0.2
        });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        const accentsGeo = new THREE.TorusGeometry(0.55, 0.08, 12, 32);
        const accentsMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0.6 });
        const accents = new THREE.Mesh(accentsGeo, accentsMat);
        accents.rotation.x = Math.PI / 2;
        accents.position.y = 0.4;
        group.add(accents);

        group.userData.ignoreGroundRay = true;
        return group;
    }

    initInputListeners() {
        window.addEventListener('keydown', (evt) => {
            if (evt.repeat) return;
            if (FORWARD_KEYS.has(evt.key)) this.keys.forward = true;
            if (BACKWARD_KEYS.has(evt.key)) this.keys.backward = true;
            if (LEFT_KEYS.has(evt.key)) this.keys.left = true;
            if (RIGHT_KEYS.has(evt.key)) this.keys.right = true;
            if (evt.key === ' ') {
                this.keys.jump = true;
                this.jumpRequested = true;
            }
            if (evt.key === 'Shift') this.keys.sprint = true;
            if (evt.key.toLowerCase() === 'e') this.pendingInteraction = true;
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
            moveX = headingSin * normForward * -1 + headingCos * normStrafe;
            moveZ = headingCos * normForward + headingSin * normStrafe;
        }

        const targetSpeed = this.maxGroundSpeed * (this.keys.sprint ? this.sprintMultiplier : 1);
        const desiredVx = moveX * targetSpeed;
        const desiredVz = moveZ * targetSpeed;

        const accel = this.inAir ? this.airAccel : this.groundAccel;
        const decel = this.inAir ? this.airAccel : this.groundDeaccel;

        this.vel.x = this.approach(this.vel.x, desiredVx, accel * delta, decel * delta);
        this.vel.z = this.approach(this.vel.z, desiredVz, accel * delta, decel * delta);

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
        const origin = this.camera.position.clone();
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion).normalize();
        const raycaster = new THREE.Raycaster(origin, direction, 0, 6);
        const objects = this.scene.children.filter(obj => obj.userData?.environmentId);
        const intersects = raycaster.intersectObjects(objects, true);
        if (intersects.length === 0) {
            return;
        }
        const match = intersects.find(hit => {
            return Boolean(getEnvironmentId(hit.object));
        });
        if (!match) {
            return;
        }
        const environmentId = getEnvironmentId(match.object);
        this.network.sendInteraction(environmentId);
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

function getEnvironmentId(object) {
    let current = object;
    while (current) {
        if (current.userData && current.userData.environmentId) {
            return current.userData.environmentId;
        }
        current = current.parent;
    }
    return null;
}
