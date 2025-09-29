// world.js - 3D world rendering using Three.js

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';

const WALK_SIZE = 10;
const TILE_SIZE = 40; // size of a single step in world units (stretched 10x)
const HEIGHT_STEP = 1.5; // vertical distance between steps
const TILE_THICKNESS = 1.2;
const MIN_WALK_DEPTH = -4;
const MAX_WALK_DEPTH = 5;
const PLAYER_HEIGHT_OFFSET = 1.4;
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
        this.localPlayer = { x: 0, z: 0, heading: 0 };
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
        this.scene.fog = new THREE.Fog(0x0f1118, 30, 120);

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

        this.tileOriginOffset = (WALK_SIZE - 1) / 2;
        const walkData = this.generateWalkTiles();
        this.walkTiles = walkData.tiles;
        this.walkHeights = walkData.heights;
        this.walkGroup = this.buildWalkMesh();
        this.scene.add(this.walkGroup);

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
    }

    handleResize() {
        const width = window.innerWidth;
        const height = window.innerHeight;
        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
    }

    generateWalkTiles() {
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

        const heights = Array.from({ length: WALK_SIZE }, () => Array(WALK_SIZE).fill(0));
        const tiles = Array.from({ length: WALK_SIZE }, () => Array(WALK_SIZE).fill(null));

        for (let index = 0; index < sequenceLength; index++) {
            const { x, z } = coords[index];
            const height = heightSequence[index];
            heights[z][x] = height;
            const tile = tiles[z][x] ?? { height, ramp: null, cornerHeights: null };
            tile.height = height;
            tile.ramp = null;
            tiles[z][x] = tile;
        }

        for (let index = 1; index < sequenceLength; index++) {
            const currentCoord = coords[index];
            const previousCoord = coords[index - 1];
            const currentHeight = heightSequence[index];
            const previousHeight = heightSequence[index - 1];
            if (currentHeight === previousHeight) {
                continue;
            }
            const tile = tiles[currentCoord.z][currentCoord.x];
            tile.ramp = this.createRampInfo(previousCoord, currentCoord, previousHeight, currentHeight);
        }

        for (let z = 0; z < WALK_SIZE; z++) {
            for (let x = 0; x < WALK_SIZE; x++) {
                const tile = tiles[z][x];
                tile.cornerHeights = this.computeCornerHeights(tile);
            }
        }

        return { tiles, heights };
    }

    createRampInfo(previousCoord, currentCoord, entryHeight, exitHeight) {
        const dx = currentCoord.x - previousCoord.x;
        const dz = currentCoord.z - previousCoord.z;
        let entry = 'west';
        if (dx === 1) {
            entry = 'west';
        } else if (dx === -1) {
            entry = 'east';
        } else if (dz === 1) {
            entry = 'north';
        } else if (dz === -1) {
            entry = 'south';
        }
        const axis = entry === 'west' || entry === 'east' ? 'x' : 'z';
        return { axis, entry, entryHeight, exitHeight };
    }

    computeCornerHeights(tile) {
        const height = tile?.height ?? 0;
        if (!tile?.ramp) {
            return { nw: height, ne: height, se: height, sw: height };
        }
        const { entry, entryHeight, exitHeight } = tile.ramp;
        switch (entry) {
            case 'west':
                return { nw: entryHeight, sw: entryHeight, ne: exitHeight, se: exitHeight };
            case 'east':
                return { ne: entryHeight, se: entryHeight, nw: exitHeight, sw: exitHeight };
            case 'north':
                return { nw: entryHeight, ne: entryHeight, sw: exitHeight, se: exitHeight };
            case 'south':
                return { sw: entryHeight, se: entryHeight, nw: exitHeight, ne: exitHeight };
            default:
                return { nw: height, ne: height, se: height, sw: height };
        }
    }

    buildWalkMesh() {
        const group = new THREE.Group();
        group.receiveShadow = true;

        for (let z = 0; z < WALK_SIZE; z++) {
            for (let x = 0; x < WALK_SIZE; x++) {
                const tileInfo = this.walkTiles[z][x];
                const tile = this.createTileMesh(tileInfo);
                const worldX = (x - this.tileOriginOffset) * TILE_SIZE;
                const worldZ = (z - this.tileOriginOffset) * TILE_SIZE;
                tile.position.set(worldX, 0, worldZ);
                group.add(tile);
            }
        }

        const undersideSize = WALK_SIZE * TILE_SIZE + TILE_SIZE * 0.4;
        const undersideThickness = TILE_SIZE * 0.25;
        const lowestBase = MIN_WALK_DEPTH * HEIGHT_STEP - TILE_THICKNESS;
        const undersideDepth = lowestBase - undersideThickness * 0.5 - TILE_THICKNESS;
        const undersideGeometry = new THREE.BoxGeometry(undersideSize, undersideThickness, undersideSize);
        const undersideMaterial = new THREE.MeshStandardMaterial({ color: 0x181924, metalness: 0.05, roughness: 0.85 });
        const underside = new THREE.Mesh(undersideGeometry, undersideMaterial);
        underside.position.y = undersideDepth;
        underside.receiveShadow = true;
        group.add(underside);

        return group;
    }

    createTileMesh(tileInfo) {
        const heightIndex = tileInfo?.height ?? 0;
        const heightColor = new THREE.Color();
        const hue = clamp(0.62 - heightIndex * 0.035, 0.45, 0.75);
        const lightness = clamp(0.32 + heightIndex * 0.04, 0.18, 0.6);
        heightColor.setHSL(hue, 0.45, lightness);

        const material = new THREE.MeshStandardMaterial({
            color: heightColor,
            metalness: 0.15,
            roughness: 0.85,
            flatShading: true
        });
        const geometry = this.createTileGeometry(tileInfo);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;

        const edgeGeometry = new THREE.EdgesGeometry(geometry);
        const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1f2331, linewidth: 1 });
        const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
        mesh.add(edges);

        return mesh;
    }

    createTileGeometry(tileInfo) {
        const halfSize = TILE_SIZE * 0.5;
        const corners = tileInfo?.cornerHeights ?? { nw: 0, ne: 0, se: 0, sw: 0 };
        const topHeights = {
            nw: (corners.nw ?? 0) * HEIGHT_STEP,
            ne: (corners.ne ?? 0) * HEIGHT_STEP,
            se: (corners.se ?? 0) * HEIGHT_STEP,
            sw: (corners.sw ?? 0) * HEIGHT_STEP
        };
        const minTop = Math.min(topHeights.nw, topHeights.ne, topHeights.se, topHeights.sw);
        const baseY = minTop - TILE_THICKNESS;

        const vertices = new Float32Array([
            -halfSize, topHeights.nw, -halfSize,
            halfSize, topHeights.ne, -halfSize,
            halfSize, topHeights.se, halfSize,
            -halfSize, topHeights.sw, halfSize,
            -halfSize, baseY, -halfSize,
            halfSize, baseY, -halfSize,
            halfSize, baseY, halfSize,
            -halfSize, baseY, halfSize
        ]);

        const indices = [
            0, 1, 2,
            0, 2, 3,
            7, 6, 5,
            7, 5, 4,
            0, 1, 5,
            0, 5, 4,
            1, 2, 6,
            1, 6, 5,
            2, 3, 7,
            2, 7, 6,
            3, 0, 4,
            3, 4, 7
        ];

        const geometry = new THREE.BufferGeometry();
        geometry.setIndex(indices);
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.computeVertexNormals();
        return geometry;
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

    updateLocalPlayer(x, z, heading = 0) {
        this.localPlayer = { x, z, heading };
        const y = this.getGroundHeight(x, z) + PLAYER_HEIGHT_OFFSET;
        this.localPlayerMesh.position.set(x, y, z);
        this.localPlayerMesh.rotation.y = heading;
        this.cameraTarget.set(x, y + 2.5, z);
    }

    upsertRemotePlayer(snapshot) {
        if (!snapshot || !snapshot.playerId) {
            return;
        }
        if (snapshot.playerId === this.localPlayerId) {
            this.updateLocalPlayer(snapshot.x ?? 0, snapshot.z ?? 0, snapshot.heading ?? 0);
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
        const desiredPosition = new THREE.Vector3(
            this.cameraTarget.x + Math.sin(this.localPlayer.heading ?? 0) * -18,
            this.cameraTarget.y + 16,
            this.cameraTarget.z + Math.cos(this.localPlayer.heading ?? 0) * -18
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
        const normalizedX = x / TILE_SIZE + this.tileOriginOffset;
        const normalizedZ = z / TILE_SIZE + this.tileOriginOffset;
        const ix = Math.round(normalizedX);
        const iz = Math.round(normalizedZ);
        if (ix < 0 || ix >= WALK_SIZE || iz < 0 || iz >= WALK_SIZE) {
            return 0;
        }
        const tile = this.walkTiles?.[iz]?.[ix];
        if (!tile) {
            return 0;
        }
        const corners = tile.cornerHeights ?? { nw: tile.height, ne: tile.height, se: tile.height, sw: tile.height };
        const halfSize = TILE_SIZE * 0.5;
        const tileCenterX = (ix - this.tileOriginOffset) * TILE_SIZE;
        const tileCenterZ = (iz - this.tileOriginOffset) * TILE_SIZE;
        const localX = clamp((x - tileCenterX + halfSize) / (TILE_SIZE), 0, 1);
        const localZ = clamp((z - tileCenterZ + halfSize) / (TILE_SIZE), 0, 1);

        const topNW = (corners.nw ?? tile.height) * HEIGHT_STEP;
        const topNE = (corners.ne ?? tile.height) * HEIGHT_STEP;
        const topSE = (corners.se ?? tile.height) * HEIGHT_STEP;
        const topSW = (corners.sw ?? tile.height) * HEIGHT_STEP;

        const northHeight = topNW * (1 - localX) + topNE * localX;
        const southHeight = topSW * (1 - localX) + topSE * localX;
        const interpolated = northHeight * (1 - localZ) + southHeight * localZ;
        return interpolated;
    }
}
