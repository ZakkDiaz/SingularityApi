// world.js - 3D world rendering using Three.js

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';

const WALK_SIZE = 10;
const TILE_SIZE = 40; // base horizontal span per cell (already scaled up)
const HEIGHT_STEP = TILE_SIZE * 0.5; // elevation delta between consecutive steps
const MIN_WALK_DEPTH = -4;
const MAX_WALK_DEPTH = 5;
export const PLAYER_HEIGHT_OFFSET = 1.4;
const MOB_HEIGHT_OFFSET = 1.2;
const ATTACK_HEIGHT = 0.2;

const MOB_FLASH_DURATION_MS = 250;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function choice(options) {
    return options[Math.floor(Math.random() * options.length)];
}

export class World {
    constructor() {
        this.localPlayerId = null;
        this.localPlayer = { x: 0, y: PLAYER_HEIGHT_OFFSET, z: 0, heading: 0 };
        this.remotePlayers = new Map();
        this.mobs = new Map();
        this.attacks = new Map();
        this.mobFlashTimers = new Map();
        this.highlightedMobId = null;
        this.debugMode = false;
        this.debugInfo = null;
        this.timeOfDay = 0;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0f1118);
        this.scene.fog = null;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.setPixelRatio(window.devicePixelRatio ?? 1);

        const existingCanvas = document.getElementById('gameCanvas');
        if (existingCanvas && existingCanvas.parentElement) {
            existingCanvas.parentElement.removeChild(existingCanvas);
        }
        this.renderer.domElement.id = 'gameCanvas';
        document.body.appendChild(this.renderer.domElement);

        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 400);
        this.camera.position.set(0, 28, 28);
        this.cameraTarget = new THREE.Vector3(0, 0, 0);
        this.cameraLerpSpeed = 0.08;
        this.cameraYaw = 0;
        this.cameraPitch = -0.6;
        this.cameraDistance = 32;
        this.minCameraDistance = 12;
        this.maxCameraDistance = 80;
        this.headingListener = null;
        this.pointerLocked = false;

        this.cellOriginOffset = (WALK_SIZE - 1) / 2;
        this.vertexOriginOffset = WALK_SIZE / 2;
        const heightData = this.generateTerrainHeightMaps();
        this.cellHeights = heightData.cellLevels;
        this.vertexLevels = heightData.vertexLevels;
        this.vertexHeights = heightData.vertexHeights;
        this.walkMesh = this.buildTerrainMesh();
        this.scene.add(this.walkMesh);

        this.ambientLight = new THREE.HemisphereLight(0x9bbcff, 0x1a1120, 0.85);
        this.scene.add(this.ambientLight);

        this.sunLight = new THREE.DirectionalLight(0xffffff, 0.7);
        this.sunLight.position.set(30, 40, 18);
        this.sunLight.castShadow = true;
        this.sunLight.shadow.mapSize.set(2048, 2048);
        this.sunLight.shadow.camera.near = 1;
        this.sunLight.shadow.camera.far = 120;
        this.sunLight.shadow.camera.left = -60;
        this.sunLight.shadow.camera.right = 60;
        this.sunLight.shadow.camera.top = 60;
        this.sunLight.shadow.camera.bottom = -60;
        this.scene.add(this.sunLight);

        this.localPlayerMesh = this.createPlayerMesh(0x4bffa5);
        this.scene.add(this.localPlayerMesh);

        this.highlightMesh = this.createHighlightMesh();
        this.highlightMesh.visible = false;
        this.scene.add(this.highlightMesh);

        window.addEventListener('resize', () => this.handleResize());
        this.handleResize();
        this.initCameraControls();
    }

    handleResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    initCameraControls() {
        const canvas = this.renderer.domElement;
        if (!canvas) {
            return;
        }

        canvas.addEventListener('click', () => {
            if (canvas.requestPointerLock) {
                canvas.requestPointerLock();
            }
        });

        document.addEventListener('pointerlockchange', () => {
            this.pointerLocked = document.pointerLockElement === canvas;
        });

        document.addEventListener('mousemove', (event) => {
            if (!this.pointerLocked) {
                return;
            }
            const yawDelta = (event.movementX ?? 0) * 0.0025;
            const pitchDelta = (event.movementY ?? 0) * 0.0025;
            this.cameraYaw -= yawDelta;
            this.cameraPitch = clamp(this.cameraPitch - pitchDelta, -1.3, 0.35);
            if (typeof this.headingListener === 'function') {
                this.headingListener(this.cameraYaw);
            }
        });

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const delta = (event.deltaY ?? 0) * 0.05;
            this.cameraDistance = clamp(this.cameraDistance + delta, this.minCameraDistance, this.maxCameraDistance);
        }, { passive: false });
    }

    setHeadingListener(listener) {
        this.headingListener = listener;
    }

    setCameraYaw(yaw) {
        this.cameraYaw = yaw;
    }

    generateTerrainHeightMaps() {
        const coords = [];
        for (let z = 0; z < WALK_SIZE; z++) {
            if (z % 2 === 0) {
                for (let x = 0; x < WALK_SIZE; x++) {
                    coords.push({ x, z });
                }
            } else {
                for (let x = WALK_SIZE - 1; x >= 0; x--) {
                    coords.push({ x, z });
                }
            }
        }

        const sequenceLength = coords.length;
        const heightSequence = new Array(sequenceLength);
        let current = 0;
        for (let index = 0; index < sequenceLength; index++) {
            heightSequence[index] = current;
            if (index === sequenceLength - 1) {
                break;
            }
            const deltas = [-1, 0, 1]
                .map(delta => current + delta)
                .filter(next => next >= MIN_WALK_DEPTH && next <= MAX_WALK_DEPTH);
            current = choice(deltas);
        }

        const cellLevels = Array.from({ length: WALK_SIZE }, () => Array(WALK_SIZE).fill(0));
        for (let index = 0; index < sequenceLength; index++) {
            const { x, z } = coords[index];
            cellLevels[z][x] = heightSequence[index];
        }

        const vertexLevels = Array.from({ length: WALK_SIZE + 1 }, () => Array(WALK_SIZE + 1).fill(0));
        for (let vz = 0; vz <= WALK_SIZE; vz++) {
            for (let vx = 0; vx <= WALK_SIZE; vx++) {
                const samples = [];
                if (vx > 0 && vz > 0) samples.push(cellLevels[vz - 1]?.[vx - 1]);
                if (vx > 0 && vz < WALK_SIZE) samples.push(cellLevels[vz]?.[vx - 1]);
                if (vx < WALK_SIZE && vz > 0) samples.push(cellLevels[vz - 1]?.[vx]);
                if (vx < WALK_SIZE && vz < WALK_SIZE) samples.push(cellLevels[vz]?.[vx]);

                const validSamples = samples.filter(sample => sample !== undefined && sample !== null);
                const average = validSamples.length > 0
                    ? validSamples.reduce((sum, value) => sum + value, 0) / validSamples.length
                    : 0;
                const quantized = Math.round(average);
                vertexLevels[vz][vx] = clamp(quantized, MIN_WALK_DEPTH, MAX_WALK_DEPTH);
            }
        }

        const vertexHeights = vertexLevels.map(row => row.map(level => level * HEIGHT_STEP));
        return { cellLevels, vertexLevels, vertexHeights };
    }

    buildTerrainMesh() {
        const vertexCountPerAxis = WALK_SIZE + 1;
        const positions = [];
        const indices = [];
        const colors = [];
        const uvs = [];
        const color = new THREE.Color();
        const minLevel = MIN_WALK_DEPTH;
        const maxLevel = MAX_WALK_DEPTH;
        const levelSpan = Math.max(maxLevel - minLevel, 1);

        for (let vz = 0; vz < vertexCountPerAxis; vz++) {
            for (let vx = 0; vx < vertexCountPerAxis; vx++) {
                const level = this.vertexLevels[vz][vx];
                const height = this.vertexHeights[vz][vx];
                const worldX = (vx - this.vertexOriginOffset) * TILE_SIZE;
                const worldZ = (vz - this.vertexOriginOffset) * TILE_SIZE;
                positions.push(worldX, height, worldZ);

                const t = (level - minLevel) / levelSpan;
                color.setHSL(clamp(0.55 - t * 0.18, 0.38, 0.68), 0.5, clamp(0.25 + t * 0.35, 0.2, 0.65));
                colors.push(color.r, color.g, color.b);

                uvs.push(vx / WALK_SIZE, vz / WALK_SIZE);
            }
        }

        for (let z = 0; z < WALK_SIZE; z++) {
            for (let x = 0; x < WALK_SIZE; x++) {
                const topLeft = z * vertexCountPerAxis + x;
                const topRight = topLeft + 1;
                const bottomLeft = (z + 1) * vertexCountPerAxis + x;
                const bottomRight = bottomLeft + 1;

                indices.push(topLeft, bottomLeft, topRight);
                indices.push(topRight, bottomLeft, bottomRight);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            metalness: 0.12,
            roughness: 0.82,
            flatShading: false
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.name = 'terrain';
        return mesh;
    }

    createPlayerMesh(baseColor) {
        const group = new THREE.Group();

        const pedestalGeometry = new THREE.CylinderGeometry(0.9, 0.9, 0.3, 18);
        const pedestalMaterial = new THREE.MeshStandardMaterial({ color: 0x1c2230, metalness: 0.1, roughness: 0.85 });
        const pedestal = new THREE.Mesh(pedestalGeometry, pedestalMaterial);
        pedestal.castShadow = true;
        pedestal.receiveShadow = true;
        pedestal.position.y = 0.15;
        group.add(pedestal);

        const bodyGeometry = new THREE.CylinderGeometry(0.6, 0.8, 2.2, 16);
        const bodyMaterial = new THREE.MeshStandardMaterial({ color: baseColor, metalness: 0.25, roughness: 0.35 });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        body.position.y = 1.4;
        body.castShadow = true;
        group.add(body);

        const headGeometry = new THREE.SphereGeometry(0.55, 18, 16);
        const headMaterial = new THREE.MeshStandardMaterial({ color: 0xf3f7ff, metalness: 0.05, roughness: 0.4 });
        const head = new THREE.Mesh(headGeometry, headMaterial);
        head.position.y = 2.5;
        head.castShadow = true;
        group.add(head);

        return group;
    }

    createMobMesh(color = 0xf26c6c) {
        const group = new THREE.Group();

        const baseGeometry = new THREE.CylinderGeometry(0.8, 0.8, 0.25, 14);
        const baseMaterial = new THREE.MeshStandardMaterial({ color: 0x2a1622, roughness: 0.9, metalness: 0.05 });
        const base = new THREE.Mesh(baseGeometry, baseMaterial);
        base.position.y = 0.12;
        base.receiveShadow = true;
        base.castShadow = true;
        group.add(base);

        const bodyGeometry = new THREE.ConeGeometry(0.85, 1.8, 14);
        const bodyMaterial = new THREE.MeshStandardMaterial({ color, flatShading: true, metalness: 0.2, roughness: 0.5 });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        body.position.y = 1.4;
        body.castShadow = true;
        group.add(body);

        const eyeGeometry = new THREE.SphereGeometry(0.25, 12, 10);
        const eyeMaterial = new THREE.MeshStandardMaterial({ color: 0xffefef, metalness: 0.1, roughness: 0.4 });
        const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
        eye.position.set(0, 1.8, 0.55);
        group.add(eye);

        return group;
    }

    createAttackMesh(radius = 1, color = 0xffc478) {
        const geometry = new THREE.RingGeometry(radius * 0.6, radius, 32);
        const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.65, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = ATTACK_HEIGHT;
        return mesh;
    }

    createHighlightMesh() {
        const geometry = new THREE.RingGeometry(1.1, 1.3, 32);
        const material = new THREE.MeshBasicMaterial({ color: 0xf8c550, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = 0.12;
        return mesh;
    }

    setLocalPlayerId(id) {
        this.localPlayerId = id;
    }

    updateLocalPlayer({ x = 0, y = null, z = 0, heading = 0 } = {}) {
        const groundY = this.getGroundHeight(x, z) + PLAYER_HEIGHT_OFFSET;
        const actualY = typeof y === 'number' ? Math.max(groundY, y) : groundY;
        this.localPlayer = { x, y: actualY, z, heading };
        this.localPlayerMesh.position.set(x, actualY, z);
        this.localPlayerMesh.rotation.y = heading;
        this.cameraTarget.set(x, actualY + 1.8, z);
        if (!this.pointerLocked) {
            this.cameraYaw = heading;
        }
    }

    upsertRemotePlayer(snapshot) {
        if (!snapshot || !snapshot.playerId) {
            return;
        }
        if (snapshot.playerId === this.localPlayerId) {
            this.updateLocalPlayer({
                x: snapshot.x ?? 0,
                y: typeof snapshot.y === 'number' ? snapshot.y : null,
                z: snapshot.z ?? 0,
                heading: snapshot.heading ?? 0
            });
            return;
        }

        let entry = this.remotePlayers.get(snapshot.playerId);
        if (!entry) {
            const mesh = this.createPlayerMesh(0x4695ff);
            this.scene.add(mesh);
            entry = { mesh, name: snapshot.displayName ?? snapshot.playerId };
            this.remotePlayers.set(snapshot.playerId, entry);
        }

        entry.name = snapshot.displayName ?? snapshot.playerId;
        entry.mesh.visible = true;
        const x = snapshot.x ?? 0;
        const z = snapshot.z ?? 0;
        const heading = snapshot.heading ?? 0;
        const y = this.getGroundHeight(x, z) + PLAYER_HEIGHT_OFFSET;
        entry.mesh.position.set(x, y, z);
        entry.mesh.rotation.y = heading;
    }

    removeRemotePlayer(playerId) {
        const entry = this.remotePlayers.get(playerId);
        if (entry) {
            this.scene.remove(entry.mesh);
            entry.mesh.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose?.();
                if (obj.material) {
                    if (Array.isArray(obj.material)) {
                        obj.material.forEach(mat => mat.dispose?.());
                    } else {
                        obj.material.dispose?.();
                    }
                }
            });
        }
        this.remotePlayers.delete(playerId);
    }

    ingestChunks(chunks = []) {
        const seenMobIds = new Set();
        chunks.forEach(chunk => {
            (chunk.mobs ?? []).forEach(mob => {
                this.updateMob(mob);
                seenMobIds.add(mob.id);
            });
        });

        for (const mobId of this.mobs.keys()) {
            if (!seenMobIds.has(mobId)) {
                const entry = this.mobs.get(mobId);
                if (entry?.mesh) {
                    this.scene.remove(entry.mesh);
                    entry.mesh.traverse(obj => {
                        if (obj.geometry) obj.geometry.dispose?.();
                        if (obj.material) {
                            if (Array.isArray(obj.material)) {
                                obj.material.forEach(mat => mat.dispose?.());
                            } else {
                                obj.material.dispose?.();
                            }
                        }
                    });
                }
                this.mobs.delete(mobId);
                this.mobFlashTimers.delete(mobId);
            }
        }
    }

    updateMob(mob) {
        if (!mob || !mob.id) {
            return;
        }

        let entry = this.mobs.get(mob.id);
        if (!entry) {
            const mesh = this.createMobMesh();
            this.scene.add(mesh);
            entry = { mesh };
            this.mobs.set(mob.id, entry);
        }

        entry.name = mob.name ?? 'Enemy';
        entry.isAlive = mob.isAlive !== false;
        entry.healthFraction = typeof mob.healthFraction === 'number' ? mob.healthFraction : 1;
        entry.targetPlayerId = mob.targetPlayerId ?? null;
        entry.x = mob.x ?? 0;
        entry.z = mob.z ?? 0;

        const y = this.getGroundHeight(entry.x, entry.z) + MOB_HEIGHT_OFFSET;
        entry.mesh.position.set(entry.x, y, entry.z);
        entry.mesh.visible = entry.isAlive;
    }

    applyMobUpdate(mobs) {
        if (!Array.isArray(mobs)) {
            return;
        }
        mobs.forEach(mob => this.updateMob(mob));
    }

    playMobAttack(mobId) {
        if (!mobId) {
            return;
        }
        const until = performance.now() + MOB_FLASH_DURATION_MS;
        this.mobFlashTimers.set(mobId, until);
    }

    setHighlightedMob(mobId) {
        this.highlightedMobId = mobId || null;
        if (!this.highlightedMobId || !this.mobs.has(this.highlightedMobId)) {
            this.highlightMesh.visible = false;
            return;
        }

        const mob = this.mobs.get(this.highlightedMobId);
        if (!mob || !mob.isAlive) {
            this.highlightMesh.visible = false;
            return;
        }
        this.highlightMesh.visible = true;
        const y = this.getGroundHeight(mob.x, mob.z) + 0.12;
        this.highlightMesh.position.set(mob.x, y, mob.z);
    }

    setDebugMode(enabled) {
        this.debugMode = Boolean(enabled);
    }

    updateWorldTime(timeOfDayFraction) {
        this.timeOfDay = timeOfDayFraction;
        const angle = timeOfDayFraction * Math.PI * 2;
        const sunY = Math.sin(angle) * 35 + 20;
        const sunX = Math.cos(angle) * 45;
        const sunZ = Math.sin(angle * 0.8) * 30;
        this.sunLight.position.set(sunX, sunY, sunZ);
        const ambientIntensity = clamp(0.35 + Math.sin(angle) * 0.45, 0.2, 0.9);
        this.ambientLight.intensity = ambientIntensity;
        this.sunLight.intensity = clamp(0.4 + Math.sin(angle) * 0.6, 0.2, 1.0);
    }

    findNearestMob(position, maxDistance = Infinity) {
        let best = null;
        let bestDistance = maxDistance;
        for (const [id, mob] of this.mobs) {
            if (!mob.isAlive) {
                continue;
            }
            const dx = (mob.x ?? 0) - position.x;
            const dz = (mob.z ?? 0) - position.z;
            const distance = Math.hypot(dx, dz);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = { id, name: mob.name, x: mob.x, z: mob.z, distance };
            }
        }
        return best;
    }

    render(debugInfo = undefined) {
        if (debugInfo !== undefined) {
            this.debugInfo = debugInfo;
        }

        const now = performance.now();

        for (const entry of this.mobs.values()) {
            entry?.mesh?.scale.set(1, 1, 1);
        }

        for (const [mobId, until] of this.mobFlashTimers) {
            if (until <= now) {
                this.mobFlashTimers.delete(mobId);
                continue;
            }
            const entry = this.mobs.get(mobId);
            if (entry?.mesh) {
                const pulse = 1 + Math.sin((until - now) * 0.02) * 0.15;
                entry.mesh.scale.set(pulse, pulse, pulse);
            }
        }

        if (this.highlightedMobId && this.mobs.has(this.highlightedMobId)) {
            const mob = this.mobs.get(this.highlightedMobId);
            if (!mob?.isAlive) {
                this.highlightMesh.visible = false;
            } else {
                this.highlightMesh.visible = true;
                const y = this.getGroundHeight(mob.x, mob.z) + 0.12;
                this.highlightMesh.position.set(mob.x, y, mob.z);
            }
        } else {
            this.highlightMesh.visible = false;
        }

        this.updateAttacksVisuals();
        this.updateCamera();
        this.renderer.render(this.scene, this.camera);
    }

    updateCamera() {
        const cosPitch = Math.cos(this.cameraPitch);
        const sinPitch = Math.sin(this.cameraPitch);
        const sinYaw = Math.sin(this.cameraYaw);
        const cosYaw = Math.cos(this.cameraYaw);

        const offsetX = sinYaw * cosPitch * this.cameraDistance;
        const offsetY = sinPitch * this.cameraDistance;
        const offsetZ = cosYaw * cosPitch * this.cameraDistance;

        const desiredPosition = new THREE.Vector3(
            this.cameraTarget.x - offsetX,
            this.cameraTarget.y - offsetY,
            this.cameraTarget.z - offsetZ
        );
        this.camera.position.lerp(desiredPosition, this.cameraLerpSpeed);
        this.camera.lookAt(this.cameraTarget);
    }

    spawnAttack(data) {
        if (!data) {
            return;
        }
        const id = data.attackId ?? data.id;
        if (!id) {
            return;
        }

        const now = performance.now();
        let entry = this.attacks.get(id);
        if (!entry) {
            const mesh = this.createAttackMesh(data.radius ?? 1);
            this.scene.add(mesh);
            entry = { mesh, behavior: (data.behavior ?? 'melee').toLowerCase(), expireAt: null, completed: false };
            this.attacks.set(id, entry);
        }
        entry.behavior = (data.behavior ?? 'melee').toLowerCase();
        entry.completed = false;
        entry.expireAt = null;
        entry.mesh.visible = true;
        entry.mesh.scale.set(1, 1, 1);
        const y = this.getGroundHeight(data.originX ?? data.x ?? 0, data.originZ ?? data.z ?? 0) + ATTACK_HEIGHT;
        entry.mesh.position.set(data.x ?? data.originX ?? 0, y, data.z ?? data.originZ ?? 0);
        entry.lastUpdated = now;
    }

    updateAttacks(snapshots = [], completedIds = []) {
        const now = performance.now();
        if (Array.isArray(snapshots)) {
            snapshots.forEach(snapshot => {
                const id = snapshot.attackId ?? snapshot.id;
                if (!id) {
                    return;
                }
                let entry = this.attacks.get(id);
                if (!entry) {
                    const mesh = this.createAttackMesh(snapshot.radius ?? 1);
                    this.scene.add(mesh);
                    entry = { mesh, behavior: (snapshot.behavior ?? 'melee').toLowerCase(), expireAt: null, completed: false };
                    this.attacks.set(id, entry);
                }
                entry.behavior = (snapshot.behavior ?? 'melee').toLowerCase();
                const radius = Math.max(snapshot.radius ?? 1, 0.3);
                entry.mesh.geometry.dispose();
                entry.mesh.geometry = new THREE.RingGeometry(radius * 0.6, radius, 32);
                const y = this.getGroundHeight(snapshot.x ?? 0, snapshot.z ?? 0) + ATTACK_HEIGHT;
                entry.mesh.position.set(snapshot.x ?? 0, y, snapshot.z ?? 0);
                entry.mesh.visible = true;
                entry.completed = Boolean(snapshot.completed);
                entry.expireAt = null;
                entry.lastUpdated = now;
            });
        }

        if (Array.isArray(completedIds)) {
            completedIds.forEach(id => {
                const entry = this.attacks.get(id);
                if (entry) {
                    entry.completed = true;
                    entry.expireAt = now + 200;
                }
            });
        }

        for (const [id, entry] of this.attacks) {
            if (entry.completed && entry.expireAt && entry.expireAt <= now) {
                this.scene.remove(entry.mesh);
                entry.mesh.geometry.dispose();
                if (entry.mesh.material) {
                    entry.mesh.material.dispose?.();
                }
                this.attacks.delete(id);
                continue;
            }
            const lastUpdated = entry.lastUpdated ?? now;
            if (!entry.completed && now - lastUpdated > 800) {
                this.scene.remove(entry.mesh);
                entry.mesh.geometry.dispose();
                if (entry.mesh.material) {
                    entry.mesh.material.dispose?.();
                }
                this.attacks.delete(id);
            }
        }
    }

    updateAttacksVisuals() {
        const now = performance.now();
        for (const entry of this.attacks.values()) {
            if (!entry.mesh.visible) {
                continue;
            }
            if (entry.completed && entry.expireAt) {
                const remaining = entry.expireAt - now;
                const alpha = clamp(remaining / 200, 0, 1);
                entry.mesh.material.opacity = alpha * 0.65;
            } else {
                entry.mesh.material.opacity = 0.65;
            }
        }
    }

    getGroundHeight(x, z) {
        const gridX = x / TILE_SIZE + this.vertexOriginOffset;
        const gridZ = z / TILE_SIZE + this.vertexOriginOffset;
        if (gridX < 0 || gridX > WALK_SIZE || gridZ < 0 || gridZ > WALK_SIZE) {
            return 0;
        }

        const epsilon = 1e-6;
        const clampedX = clamp(gridX, 0, WALK_SIZE - epsilon);
        const clampedZ = clamp(gridZ, 0, WALK_SIZE - epsilon);
        const ix = Math.floor(clampedX);
        const iz = Math.floor(clampedZ);
        const fx = clampedX - ix;
        const fz = clampedZ - iz;

        const h00 = this.vertexHeights?.[iz]?.[ix] ?? 0;
        const h10 = this.vertexHeights?.[iz]?.[ix + 1] ?? h00;
        const h01 = this.vertexHeights?.[iz + 1]?.[ix] ?? h00;
        const h11 = this.vertexHeights?.[iz + 1]?.[ix + 1] ?? h10;

        const north = h00 * (1 - fx) + h10 * fx;
        const south = h01 * (1 - fx) + h11 * fx;
        return north * (1 - fz) + south * fz;
    }
}
