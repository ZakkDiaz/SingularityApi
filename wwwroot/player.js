export class Player {
    constructor(scene, camera, chunkLoader) {
        this.scene = scene;
        this.camera = camera;

        // Optional: chunkLoader could be some manager or function you pass in 
        // that knows how to "load or request chunk data" from the server.
        // We'll call chunkLoader.loadChunk(cx, cz) if we need new chunks.
        this.chunkLoader = chunkLoader;

        // Position & velocity
        this.pos = new THREE.Vector3(0, 0, 0);
        this.vel = new THREE.Vector3(0, 0, 0);

        this.heading = 0; // in radians

        // Movement config (BUMPED UP)
        this.maxGroundSpeed = 0.05;   // was 0.02
        this.groundAccel = 0.0006;   // was 0.0003
        this.groundDeaccel = 0.001;  // was 0.0005
        this.jumpForce = 0.06;       // was 0.03
        this.gravity = -0.002;       // same
        this.rotSpeed = 0.004;       // same

        this.fallThreshold = 0.05;
        this.inAir = false;

        // Key states
        this.keys = { w: false, s: false, a: false, d: false, jump: false };

        // For server net updates
        this.batchDx = 0;
        this.batchDz = 0;

        // Create a sphere mesh for the character
        const geometry = new THREE.SphereGeometry(0.3, 16, 16);
        const material = new THREE.MeshStandardMaterial({ color: 0xff0000 });
        this.mesh = new THREE.Mesh(geometry, material);
        this.scene.add(this.mesh);

        // If you're using physically-based lighting, 
        // make sure there's a light somewhere in your scene as well

        // For chunk loading
        this.chunkSize = 16;       // how big each chunk is, side to side
        this.loadRadius = 2;       // how many chunks around the player to load
        this.loadedChunks = new Set(); // track which chunks are loaded

        this.initKeyListeners();
    }

    initKeyListeners() {
        window.addEventListener('keydown', (evt) => {
            // Prevent default so arrow keys/space won't scroll the page
            if (['w', 's', 'a', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(evt.key)) {
                evt.preventDefault();
            }

            switch (evt.key) {
                case 'w': case 'ArrowUp': this.keys.w = true; break;
                case 's': case 'ArrowDown': this.keys.s = true; break;
                case 'a': case 'ArrowLeft': this.keys.a = true; break;
                case 'd': case 'ArrowRight': this.keys.d = true; break;
                case ' ': this.keys.jump = true; break;
            }
        });

        window.addEventListener('keyup', (evt) => {
            switch (evt.key) {
                case 'w': case 'ArrowUp': this.keys.w = false; break;
                case 's': case 'ArrowDown': this.keys.s = false; break;
                case 'a': case 'ArrowLeft': this.keys.a = false; break;
                case 'd': case 'ArrowRight': this.keys.d = false; break;
                case ' ': this.keys.jump = false; break;
            }
        });
    }

    /**
     * Call this every frame (e.g., in requestAnimationFrame).
     */
    update() {
        // 1) Rotate heading if a/d pressed
        if (this.keys.a) {
            this.heading += this.rotSpeed;
        } else if (this.keys.d) {
            this.heading -= this.rotSpeed;
        }

        // 2) Raycast to find ground
        const groundY = getGroundHeightRaycast(this.scene, this.pos.x, this.pos.z, 200, [this.mesh]);

        // 3) Check if on ground or in air
        if (!this.inAir) {
            const distToGround = groundY - this.pos.y;
            if (distToGround < -this.fallThreshold) {
                // Start falling
                this.inAir = true;
                // keep horizontal velocity
            } else {
                // Snap to ground if close
                this.pos.y = groundY;
                // Move on ground
                this.handleGroundMovement();
                // Jump
                if (this.keys.jump) {
                    this.inAir = true;
                    this.vel.y = this.jumpForce;
                } else {
                    this.vel.y = 0;
                }
            }
        } else {
            // in air => apply gravity
            this.vel.y += this.gravity;
        }

        // 4) Update position
        this.pos.add(this.vel);

        // 5) If in air, see if we landed
        if (this.inAir && this.pos.y <= groundY) {
            this.pos.y = groundY;
            this.inAir = false;
            this.vel.y = 0;
        }

        // 6) Update mesh and camera
        this.mesh.position.copy(this.pos);
        this.mesh.rotation.y = this.heading;
        this.updateCamera();

        // 7) Track movement for net
        this.batchDx += this.vel.x;
        this.batchDz += this.vel.z;

        // 8) Request chunk loading if needed
        this.loadChunksAroundPlayer();
    }

    handleGroundMovement() {
        let forward = 0;
        if (this.keys.w) forward += 1;
        if (this.keys.s) forward -= 1;

        const desiredVx = Math.sin(this.heading) * (forward * this.maxGroundSpeed);
        const desiredVz = Math.cos(this.heading) * (forward * this.maxGroundSpeed);

        this.vel.x = this.approach(this.vel.x, desiredVx, this.groundAccel, this.groundDeaccel);
        this.vel.z = this.approach(this.vel.z, desiredVz, this.groundAccel, this.groundDeaccel);
    }

    updateCamera() {
        const camDist = 5;
        const offsetX = Math.sin(this.heading) * -camDist;
        const offsetZ = Math.cos(this.heading) * -camDist;

        this.camera.position.set(
            this.pos.x + offsetX,
            this.pos.y + 2,
            this.pos.z + offsetZ
        );
        this.camera.lookAt(this.pos.x, this.pos.y, this.pos.z);
    }

    /**
     * Gradually accelerate or decelerate from current => target,
     * with separate accel/decel rates.
     */
    approach(current, target, accelRate, decelRate) {
        const diff = target - current;
        if (Math.abs(diff) < 0.000001) {
            return target;
        }
        if (diff > 0) {
            const next = current + accelRate;
            return next > target ? target : next;
        } else {
            const next = current - decelRate;
            return next < target ? target : next;
        }
    }

    sendMovementToServerIfNeeded(network) {
        const threshold = 0.1;
        if (Math.abs(this.batchDx) > threshold || Math.abs(this.batchDz) > threshold) {
            const msg = {
                type: "playerMove",
                dx: this.batchDx,
                dz: this.batchDz,
                y: this.pos.y
            };
            network.sendPlayerMove(msg);
            this.batchDx = 0;
            this.batchDz = 0;
        }
    }

    setPosition(x, y, z) {
        this.pos.set(x, y, z);
        this.mesh.position.set(x, y, z);
    }
    getPosition() {
        return { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    }

    /**
     * This is a naive chunk-load approach. We figure out which chunk the player is in,
     * plus neighbors, and request them from the chunk loader if not already loaded.
     */
    loadChunksAroundPlayer() {
        const cx = Math.floor(this.pos.x / this.chunkSize);
        const cz = Math.floor(this.pos.z / this.chunkSize);

        // For each chunk in the "radius," ensure it's loaded
        for (let x = cx - this.loadRadius; x <= cx + this.loadRadius; x++) {
            for (let z = cz - this.loadRadius; z <= cz + this.loadRadius; z++) {
                const key = `${x},${z}`;
                if (!this.loadedChunks.has(key)) {
                    this.loadedChunks.add(key);
                    if (this.chunkLoader) {
                        // This might call your own function to load/generate chunk data from server
                        this.chunkLoader.loadChunk(x, z);
                    }
                }
            }
        }
    }
}

/**
 * Raycasts straight down to find ground Y at a given x,z.
 * Returns 0 if it can’t find anything.
 */
function getGroundHeightRaycast(scene, x, z, maxHeight = 200, ignoreMeshes = []) {
    const origin = new THREE.Vector3(x, maxHeight, z);
    const dir = new THREE.Vector3(0, -1, 0);
    const raycaster = new THREE.Raycaster(origin, dir);

    // gather all objects except those to ignore
    const allMeshes = scene.children.filter(obj => !ignoreMeshes.includes(obj));

    const intersects = raycaster.intersectObjects(allMeshes, true);
    if (intersects.length > 0) {
        return intersects[0].point.y;
    }
    return 0;
}
