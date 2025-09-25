// world.js
import { log } from './utils.js';
import { createPlayerAvatar, createMobAvatar, updateHumanoidAnimation, triggerHumanoidAttack } from './avatars.js';

const CHUNK_MATERIAL = new THREE.MeshStandardMaterial({
    color: 0x6ea07c,
    roughness: 0.85,
    metalness: 0.0,
    flatShading: false
});

const AIM_TARGET_TIMEOUT_MS = 1600;

export class World {
    constructor() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1e2232);
        this.scene.fog = new THREE.FogExp2(0x1e2232, 0.003);

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000);
        this.camera.position.set(0, 8, 12);

        this.clock = new THREE.Clock();
        this.lastDelta = 0.016;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
        if (this.renderer.outputColorSpace !== undefined) {
            this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        } else {
            this.renderer.outputEncoding = THREE.sRGBEncoding;
        }
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.shadowMap.enabled = true;
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.domElement.style.position = 'absolute';
        this.renderer.domElement.style.inset = '0';
        this.renderer.domElement.style.zIndex = '0';
        document.body.appendChild(this.renderer.domElement);
        this.rendererType = 'webgl';

        this.directionalLight = new THREE.DirectionalLight(0xf7f5e9, 0.9);
        this.directionalLight.position.set(60, 100, 40);
        this.directionalLight.castShadow = true;
        this.scene.add(this.directionalLight);

        this.ambientLight = new THREE.HemisphereLight(0x9cc4ff, 0x1a2233, 0.35);
        this.scene.add(this.ambientLight);

        this.chunkMeshes = new Map();
        this.environmentMeshes = new Map();
        this.chunkEnvironmentIndex = new Map();
        this.mobActors = new Map();
        this.chunkMobIndex = new Map();
        this.remotePlayers = new Map();
        this.localPlayerId = null;
        this.localPlayerMesh = null;
        this.healthBarMaterial = new THREE.MeshBasicMaterial({
            color: 0xff5d73,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            depthTest: false
        });
        this.environmentPulse = 0;

        window.addEventListener('resize', () => this.handleResize());
        this.handleResize();

    }

    handleResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    swapRenderer(newRenderer, type = 'webgl') {
        if (!newRenderer) {
            return;
        }
        const previousCanvas = this.renderer?.domElement;
        const parent = previousCanvas?.parentElement;
        if (parent && newRenderer.domElement) {
            parent.replaceChild(newRenderer.domElement, previousCanvas);
        } else if (newRenderer.domElement) {
            newRenderer.domElement.style.position = 'absolute';
            newRenderer.domElement.style.inset = '0';
            document.body.appendChild(newRenderer.domElement);
        }
        if (this.renderer && typeof this.renderer.dispose === 'function') {
            this.renderer.dispose();
        }
        this.renderer = newRenderer;
        this.rendererType = type;
        this.handleResize();
    }

    setLocalPlayerId(id) {
        this.localPlayerId = id;
    }

    registerLocalPlayerAvatar(mesh) {
        this.localPlayerMesh = mesh;
    }

    drawNameplate(ctx, canvas, text) {
        if (!ctx || !canvas) {
            return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(18, 26, 38, 0.85)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = '600 28px "Inter", sans-serif';
        ctx.fillStyle = '#e6f0ff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    }

    buildNameplate(text) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        this.drawNameplate(ctx, canvas, text);
        const texture = new THREE.CanvasTexture(canvas);
        if (texture.colorSpace !== undefined) {
            texture.colorSpace = THREE.SRGBColorSpace;
        } else {
            texture.encoding = THREE.sRGBEncoding;
        }
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
        const sprite = new THREE.Sprite(material);
        sprite.scale.set(2.3, 0.6, 1);
        sprite.position.set(0, 2.35, 0);
        sprite.userData.nameCanvas = canvas;
        sprite.userData.nameContext = ctx;
        return sprite;
    }

    updateNameplateTexture(sprite, text) {
        const canvas = sprite?.userData?.nameCanvas;
        const ctx = sprite?.userData?.nameContext;
        if (!canvas || !ctx) {
            return;
        }
        this.drawNameplate(ctx, canvas, text);
        if (sprite.material?.map) {
            sprite.material.map.needsUpdate = true;
        }
    }

    playPlayerAbility(playerId) {
        if (!playerId) {
            return;
        }
        if (playerId === this.localPlayerId) {
            if (this.localPlayerMesh) {
                triggerHumanoidAttack(this.localPlayerMesh);
            }
            return;
        }
        const record = this.remotePlayers.get(playerId);
        if (record) {
            triggerHumanoidAttack(record.mesh);
        }
    }

    playMobAttack(mobId, targetId) {
        const record = this.mobActors.get(mobId);
        if (!record) {
            return;
        }
        if (targetId) {
            const targetPosition = this.getActorWorldPosition(targetId);
            if (targetPosition) {
                if (!record.lastAimTarget) {
                    record.lastAimTarget = new THREE.Vector3();
                }
                record.lastAimTarget.copy(targetPosition);
                record.lastAimTarget.y += 1.3;
                record.lastAimTimestamp = performance.now();
            }
        }
        triggerHumanoidAttack(record.mesh);
    }

    getDeltaSeconds() {
        return this.lastDelta;
    }

    getActorWorldPosition(actorId) {
        if (!actorId) {
            return null;
        }
        if (actorId === this.localPlayerId && this.localPlayerMesh) {
            return this.localPlayerMesh.position.clone();
        }
        const remote = this.remotePlayers.get(actorId);
        if (remote && remote.mesh) {
            return remote.mesh.position.clone();
        }
        return null;
    }

    addOrUpdateChunk(cx, cz, chunkSize, vertexList) {
        const totalVerts = (chunkSize + 1) * (chunkSize + 1);
        if (!vertexList || vertexList.length !== totalVerts) {
            log(`Chunk mismatch: got ${vertexList?.length} vs expected ${totalVerts} for chunk (${cx},${cz})`);
            return;
        }

        const positions = new Float32Array(totalVerts * 3);
        for (let i = 0; i < vertexList.length; i++) {
            positions[i * 3 + 0] = vertexList[i].x;
            positions[i * 3 + 1] = vertexList[i].y;
            positions[i * 3 + 2] = vertexList[i].z;
        }

        const indices = [];
        for (let z = 0; z < chunkSize; z++) {
            for (let x = 0; x < chunkSize; x++) {
                const topLeft = z * (chunkSize + 1) + x;
                const topRight = topLeft + 1;
                const bottomLeft = (z + 1) * (chunkSize + 1) + x;
                const bottomRight = bottomLeft + 1;
                indices.push(topLeft, bottomLeft, topRight);
                indices.push(topRight, bottomLeft, bottomRight);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(geometry, CHUNK_MATERIAL.clone());
        mesh.receiveShadow = true;
        mesh.userData.cx = cx;
        mesh.userData.cz = cz;
        mesh.userData.isTerrain = true;

        const chunkKey = `${cx},${cz}`;
        if (this.chunkMeshes.has(chunkKey)) {
            this.scene.remove(this.chunkMeshes.get(chunkKey));
        }
        this.chunkMeshes.set(chunkKey, mesh);
        this.scene.add(mesh);
    }

    updateEnvironmentForChunk(cx, cz, objects) {
        const chunkKey = `${cx},${cz}`;
        const existing = this.chunkEnvironmentIndex.get(chunkKey) || new Set();
        const nextIds = new Set();

        objects.forEach(obj => {
            if (!obj) return;
            nextIds.add(obj.id);
            this.createOrUpdateEnvironmentObject(obj);
        });

        existing.forEach(id => {
            if (!nextIds.has(id)) {
                this.removeEnvironmentObject(id);
            }
        });

        this.chunkEnvironmentIndex.set(chunkKey, nextIds);
    }

    updateEnvironmentObject(objectData) {
        if (!objectData) {
            return;
        }
        this.createOrUpdateEnvironmentObject(objectData);
    }

    createOrUpdateEnvironmentObject(data) {
        const chunkKey = `${data.chunkX},${data.chunkZ}`;
        let record = this.environmentMeshes.get(data.id);

        if (!record) {
            const mesh = this.buildEnvironmentMesh(data.type);
            mesh.userData.environmentId = data.id;
            mesh.userData.chunkKey = chunkKey;
            mesh.userData.environmentType = data.type;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            this.scene.add(mesh);
            record = { mesh, pulseOffset: Math.random() * Math.PI * 2 };
            this.environmentMeshes.set(data.id, record);

            if (!this.chunkEnvironmentIndex.has(chunkKey)) {
                this.chunkEnvironmentIndex.set(chunkKey, new Set());
            }
            this.chunkEnvironmentIndex.get(chunkKey).add(data.id);

            mesh.traverse(node => {
                node.userData = node.userData || {};
                node.userData.environmentId = data.id;
                node.userData.chunkKey = chunkKey;
                node.userData.environmentType = data.type;
            });
        } else if (record.pulseOffset === undefined) {
            record.pulseOffset = Math.random() * Math.PI * 2;
        }

        record.mesh.userData.pulseOffset = record.pulseOffset;
        record.mesh.userData.baseY = data.y;
        if (record.mesh.userData.environmentType === 'sentinel') {
            const floatHeight = record.mesh.userData.floatHeight ?? 0.95;
            record.mesh.position.set(data.x, data.y + floatHeight, data.z);
        } else {
            record.mesh.position.set(data.x, data.y, data.z);
        }
        record.mesh.rotation.y = data.rotation ?? 0;
        this.applyEnvironmentState(record.mesh, data.state);
    }

    buildEnvironmentMesh(type) {
        if (type === 'sentinel') {
            const group = new THREE.Group();

            const pedestalGeo = new THREE.CylinderGeometry(0.55, 0.7, 0.5, 18);
            const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x142131, roughness: 0.6, metalness: 0.35 });
            const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
            pedestal.castShadow = true;
            pedestal.receiveShadow = true;
            group.add(pedestal);

            const outerGeo = new THREE.IcosahedronGeometry(0.82, 1);
            const outerMat = new THREE.MeshStandardMaterial({
                color: 0x1f5281,
                emissive: 0x124063,
                emissiveIntensity: 0.7,
                roughness: 0.25,
                metalness: 0.35,
                transparent: true,
                opacity: 0.88
            });
            const outer = new THREE.Mesh(outerGeo, outerMat);
            outer.position.y = 0.95;
            outer.castShadow = true;
            outer.receiveShadow = true;
            group.add(outer);

            const coreGeo = new THREE.SphereGeometry(0.38, 20, 20);
            const coreMat = new THREE.MeshStandardMaterial({
                color: 0x9ff6ff,
                emissive: 0x4ec8ff,
                emissiveIntensity: 1.35,
                roughness: 0.1,
                metalness: 0.2,
                transparent: true,
                opacity: 0.9
            });
            const core = new THREE.Mesh(coreGeo, coreMat);
            core.position.y = 0.95;
            group.add(core);

            const haloGeo = new THREE.TorusGeometry(0.62, 0.05, 16, 64);
            const haloMat = new THREE.MeshStandardMaterial({
                color: 0x66d7ff,
                emissive: 0x2aa7ff,
                emissiveIntensity: 0.8,
                roughness: 0.25,
                metalness: 0.4
            });
            const halo = new THREE.Mesh(haloGeo, haloMat);
            halo.rotation.x = Math.PI / 2;
            halo.position.y = 0.95;
            group.add(halo);

            group.userData.outer = outer;
            group.userData.core = core;
            group.userData.halo = halo;
            group.userData.floatHeight = 0.95;

            return group;
        }

        const group = new THREE.Group();
        const trunkGeometry = new THREE.CylinderGeometry(0.15, 0.22, 2.4, 6);
        const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x5c3b2e, roughness: 0.9 });
        const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
        trunk.position.y = 1.2;
        trunk.castShadow = true;
        trunk.receiveShadow = true;

        const canopyGeometry = new THREE.ConeGeometry(1.2, 2.4, 8, 1);
        const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x3f8152, roughness: 0.6 });
        const canopy = new THREE.Mesh(canopyGeometry, canopyMaterial);
        canopy.position.y = 2.6;
        canopy.castShadow = true;

        group.add(trunk);
        group.add(canopy);
        return group;
    }

    applyEnvironmentState(mesh, state) {
        if (!state) {
            mesh.visible = true;
            return;
        }

        const cooldown = state.cooldownRemaining ?? 0;
        const type = mesh.userData.environmentType;
        const healthFraction = state.healthFraction ?? (state.isActive ? 1 : 0);
        mesh.userData.cooldown = cooldown;
        mesh.userData.isActive = state.isActive;
        mesh.userData.healthFraction = healthFraction;

        if (type === 'sentinel') {
            mesh.visible = state.isActive || cooldown > 0;
            const outer = mesh.userData.outer;
            const core = mesh.userData.core;
            const halo = mesh.userData.halo;
            if (outer && outer.material) {
                outer.material.opacity = state.isActive ? 0.55 + healthFraction * 0.35 : 0.18;
                outer.material.emissiveIntensity = state.isActive ? 0.45 + healthFraction * 0.9 : 0.08;
            }
            if (core && core.material) {
                core.visible = state.isActive;
                core.material.emissiveIntensity = state.isActive ? 1.1 + healthFraction * 0.9 : 0.1;
            }
            if (halo && halo.material) {
                halo.visible = state.isActive;
                halo.material.emissiveIntensity = state.isActive ? 0.6 + healthFraction * 0.6 : 0.1;
            }
        } else {
            mesh.visible = state.isActive;
            if (mesh.material && mesh.material.emissive) {
                mesh.material.emissiveIntensity = state.isActive ? 0.6 : 0.1;
                mesh.material.opacity = state.isActive ? 0.95 : 0.35;
            }
            mesh.scale.setScalar(state.isActive ? 1 : 0.6);
        }
    }

    syncChunkMobs(cx, cz, mobSnapshots) {
        const chunkKey = `${cx},${cz}`;
        const nextIds = new Set();

        (mobSnapshots || []).forEach(snapshot => {
            if (!snapshot || !snapshot.id) {
                return;
            }
            nextIds.add(snapshot.id);
            this.createOrUpdateMob(snapshot);
        });

        const previous = this.chunkMobIndex.get(chunkKey) || new Set();
        previous.forEach(id => {
            if (!nextIds.has(id)) {
                this.removeMob(id);
            }
        });

        this.chunkMobIndex.set(chunkKey, nextIds);
    }

    applyMobUpdate(payload) {
        if (!payload) {
            return;
        }
        const list = Array.isArray(payload) ? payload : [payload];
        list.forEach(snapshot => this.createOrUpdateMob(snapshot));
    }

    createOrUpdateMob(snapshot) {
        if (!snapshot || !snapshot.id) {
            return;
        }

        const chunkKey = `${snapshot.chunkX},${snapshot.chunkZ}`;
        if (!this.chunkMobIndex.has(chunkKey)) {
            this.chunkMobIndex.set(chunkKey, new Set());
        }
        this.chunkMobIndex.get(chunkKey).add(snapshot.id);

        let record = this.mobActors.get(snapshot.id);
        if (!record) {
            const mesh = createMobAvatar();
            mesh.userData.combatId = snapshot.id;
            mesh.userData.combatType = 'mob';
            mesh.position.set(snapshot.x, snapshot.y, snapshot.z);
            mesh.rotation.y = snapshot.heading ?? 0;
            const healthBar = this.buildMobHealthBar();
            mesh.add(healthBar);
            this.scene.add(mesh);
            record = {
                mesh,
                targetPosition: new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z),
                targetHeading: snapshot.heading ?? 0,
                lastPosition: mesh.position.clone(),
                healthBar,
                healthFraction: snapshot.healthFraction ?? 1,
                chunkKey,
                aimDirection: new THREE.Vector3(0, 0, -1),
                aimOrigin: new THREE.Vector3(),
                lastAimTarget: null,
                lastAimTimestamp: 0
            };
            this.mobActors.set(snapshot.id, record);
        }

        record.chunkKey = chunkKey;
        record.targetPosition.set(snapshot.x, snapshot.y, snapshot.z);
        record.targetHeading = snapshot.heading ?? record.targetHeading ?? 0;
        record.healthFraction = snapshot.healthFraction ?? record.healthFraction ?? 1;
        record.mesh.visible = snapshot.isAlive;
        if (record.healthBar) {
            record.healthBar.visible = snapshot.isAlive;
        }
        if (snapshot.isAlive) {
            record.mesh.position.set(snapshot.x, snapshot.y, snapshot.z);
            record.mesh.rotation.y = record.targetHeading;
            record.lastPosition.copy(record.mesh.position);
        }
    }

    buildMobHealthBar() {
        const geometry = new THREE.PlaneGeometry(1.4, 0.18);
        const material = this.healthBarMaterial.clone();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(0, 2.1, 0);
        mesh.renderOrder = 5;
        return mesh;
    }

    removeMob(id) {
        const record = this.mobActors.get(id);
        if (!record) {
            return;
        }
        if (record.mesh.parent) {
            record.mesh.parent.remove(record.mesh);
        }
        if (record.healthBar) {
            if (record.healthBar.geometry && typeof record.healthBar.geometry.dispose === 'function') {
                record.healthBar.geometry.dispose();
            }
            if (record.healthBar.material && typeof record.healthBar.material.dispose === 'function') {
                record.healthBar.material.dispose();
            }
        }
        this.mobActors.delete(id);
        if (record.chunkKey && this.chunkMobIndex.has(record.chunkKey)) {
            this.chunkMobIndex.get(record.chunkKey).delete(id);
        }
    }

    removeEnvironmentObject(id) {
        const record = this.environmentMeshes.get(id);
        if (!record) {
            return;
        }
        if (record.mesh.parent) {
            record.mesh.parent.remove(record.mesh);
        }
        this.environmentMeshes.delete(id);

        const chunkKey = record.mesh.userData.chunkKey;
        if (chunkKey && this.chunkEnvironmentIndex.has(chunkKey)) {
            this.chunkEnvironmentIndex.get(chunkKey).delete(id);
        }
    }

    cleanupDistantChunks(playerPos, maxDist) {
        this.chunkMeshes.forEach((mesh, key) => {
            const cx = mesh.userData.cx;
            const cz = mesh.userData.cz;
            const centerX = cx * 16 + 8;
            const centerZ = cz * 16 + 8;
            const dx = centerX - playerPos.x;
            const dz = centerZ - playerPos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > maxDist) {
                this.scene.remove(mesh);
                this.chunkMeshes.delete(key);
                this.removeEnvironmentObjectsForChunk(key);
                this.removeMobObjectsForChunk(key);
            }
        });
    }

    removeEnvironmentObjectsForChunk(chunkKey) {
        if (!this.chunkEnvironmentIndex.has(chunkKey)) {
            return;
        }
        const ids = Array.from(this.chunkEnvironmentIndex.get(chunkKey));
        ids.forEach(id => this.removeEnvironmentObject(id));
        this.chunkEnvironmentIndex.delete(chunkKey);
    }

    removeMobObjectsForChunk(chunkKey) {
        if (!this.chunkMobIndex.has(chunkKey)) {
            return;
        }
        const ids = Array.from(this.chunkMobIndex.get(chunkKey));
        ids.forEach(id => this.removeMob(id));
        this.chunkMobIndex.delete(chunkKey);
    }

    upsertRemotePlayer(snapshot) {
        if (!snapshot || !snapshot.playerId || snapshot.playerId === this.localPlayerId) {
            return;
        }

        let record = this.remotePlayers.get(snapshot.playerId);
        if (!record) {
            const group = createPlayerAvatar({
                bodyColor: 0x2f4c7f,
                accentColor: 0xe7f1ff,
                trimColor: 0x8bc0ff,
                weaponColor: 0xe5f6ff
            });
            const nameplate = this.buildNameplate(snapshot.displayName ?? 'Wanderer');
            group.add(nameplate);
            group.position.set(snapshot.x ?? 0, snapshot.y ?? 0, snapshot.z ?? 0);
            group.rotation.y = snapshot.heading ?? 0;
            this.scene.add(group);
            record = {
                mesh: group,
                targetPosition: new THREE.Vector3(),
                targetHeading: 0,
                lastPosition: group.position.clone(),
                nameplate,
                aimDirection: new THREE.Vector3(0, 0, -1),
                aimOrigin: new THREE.Vector3(),
                lastAimTarget: null,
                lastAimTimestamp: 0
            };
            this.remotePlayers.set(snapshot.playerId, record);
        }

        record.targetPosition.set(snapshot.x, snapshot.y, snapshot.z);
        record.targetHeading = snapshot.heading ?? 0;
        record.mesh.userData.displayName = snapshot.displayName ?? 'Wanderer';
        if (record.nameplate && record.nameplate.material?.map) {
            this.updateNameplateTexture(record.nameplate, snapshot.displayName ?? 'Wanderer');
        }
    }

    removeRemotePlayer(playerId) {
        const record = this.remotePlayers.get(playerId);
        if (!record) {
            return;
        }
        if (record.mesh.parent) {
            record.mesh.parent.remove(record.mesh);
        }
        if (record.nameplate) {
            record.nameplate.material?.map?.dispose?.();
            record.nameplate.material?.dispose?.();
        }
        this.remotePlayers.delete(playerId);
    }

    updateWorldTime(timeOfDay) {
        const angle = timeOfDay * Math.PI * 2;
        const sunHeight = Math.cos(angle);
        const sunIntensity = THREE.MathUtils.clamp(sunHeight * 0.75 + 0.35, 0.15, 1.25);

        this.directionalLight.position.set(Math.sin(angle) * 120, sunHeight * 120, Math.cos(angle * 0.5) * 120);
        this.directionalLight.intensity = sunIntensity;

        const ambient = THREE.MathUtils.clamp(0.25 + (sunHeight + 1) * 0.25, 0.15, 0.6);
        this.ambientLight.intensity = ambient;
        this.ambientLight.color.setHSL(0.58, 0.55, 0.5 + ambient * 0.3);

        const background = new THREE.Color().setHSL(0.62, 0.45, 0.28 + sunIntensity * 0.3);
        this.scene.background.copy(background);
        this.scene.fog.color.copy(background);
    }

    render() {
        const delta = this.clock.getDelta();
        this.lastDelta = delta;
        this.environmentPulse += delta;
        const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();

        this.remotePlayers.forEach(record => {
            const lerpFactor = 1 - Math.exp(-delta * 6);
            record.mesh.position.lerp(record.targetPosition, lerpFactor);
            record.mesh.rotation.y = THREE.MathUtils.lerp(record.mesh.rotation.y, record.targetHeading, lerpFactor);
            const distance = record.lastPosition.distanceTo(record.mesh.position);
            const speed = delta > 0 ? distance / delta : 0;
            if (record.aimOrigin) {
                record.aimOrigin.copy(record.mesh.position);
                record.aimOrigin.y += 1.5;
            }
            if (record.aimDirection) {
                record.aimDirection.set(0, 0, -1).applyQuaternion(record.mesh.quaternion).normalize();
            }
            const aimContext = {
                speed,
                onGround: true,
                aimOrigin: record.aimOrigin,
                aimDirection: record.aimDirection,
                aimStrength: 0.7
            };
            if (record.lastAimTarget && now - record.lastAimTimestamp < AIM_TARGET_TIMEOUT_MS) {
                aimContext.aimTarget = record.lastAimTarget;
                aimContext.aimStrength = 1;
            } else if (record.lastAimTarget && now - record.lastAimTimestamp >= AIM_TARGET_TIMEOUT_MS) {
                record.lastAimTarget = null;
            }
            updateHumanoidAnimation(record.mesh, delta, aimContext);
            if (record.nameplate) {
                record.nameplate.quaternion.copy(this.camera.quaternion);
            }
            record.lastPosition.copy(record.mesh.position);
        });

        this.mobActors.forEach(record => {
            if (!record.mesh.visible) {
                if (record.healthBar) {
                    record.healthBar.visible = false;
                }
                return;
            }
            const lerpFactor = 1 - Math.exp(-delta * 5);
            record.mesh.position.lerp(record.targetPosition, lerpFactor);
            record.mesh.rotation.y = THREE.MathUtils.lerp(record.mesh.rotation.y, record.targetHeading ?? record.mesh.rotation.y, lerpFactor);
            const distance = record.lastPosition.distanceTo(record.mesh.position);
            const speed = delta > 0 ? distance / delta : 0;
            if (record.aimOrigin) {
                record.aimOrigin.copy(record.mesh.position);
                record.aimOrigin.y += 1.55;
            }
            if (record.aimDirection) {
                record.aimDirection.set(0, 0, -1).applyQuaternion(record.mesh.quaternion).normalize();
            }
            const aimContext = {
                speed,
                onGround: true,
                aimOrigin: record.aimOrigin,
                aimDirection: record.aimDirection,
                aimStrength: 0.85
            };
            if (record.lastAimTarget && now - record.lastAimTimestamp < AIM_TARGET_TIMEOUT_MS) {
                aimContext.aimTarget = record.lastAimTarget;
                aimContext.aimStrength = 1;
            } else if (record.lastAimTarget && now - record.lastAimTimestamp >= AIM_TARGET_TIMEOUT_MS) {
                record.lastAimTarget = null;
            }
            updateHumanoidAnimation(record.mesh, delta, aimContext);
            record.lastPosition.copy(record.mesh.position);
            if (record.healthBar) {
                record.healthBar.visible = true;
                record.healthBar.scale.x = 1.3 * Math.max(0.1, record.healthFraction ?? 0);
                record.healthBar.lookAt(this.camera.position);
            }
        });

        this.environmentMeshes.forEach(({ mesh, pulseOffset = 0 }) => {
            if (!mesh.visible) {
                return;
            }

            const type = mesh.userData.environmentType;
            if (type === 'sentinel') {
                const baseY = mesh.userData.baseY ?? mesh.position.y;
                const floatHeight = mesh.userData.floatHeight ?? 0.95;
                const health = mesh.userData.healthFraction ?? 1;
                const isActive = mesh.userData.isActive;
                const offset = mesh.userData.pulseOffset ?? pulseOffset ?? 0;
                const bob = Math.sin(this.environmentPulse * 3.1 + offset) * 0.35 * (0.3 + health * 0.7);
                const targetY = isActive ? baseY + floatHeight + bob : baseY + 0.3;
                mesh.position.y = THREE.MathUtils.lerp(mesh.position.y, targetY, 1 - Math.exp(-delta * 6));

                const outer = mesh.userData.outer;
                if (outer) {
                    outer.rotation.y += delta * 0.85;
                    outer.rotation.x += delta * 0.25;
                }
                const halo = mesh.userData.halo;
                if (halo) {
                    halo.rotation.z += delta * 1.2;
                }
                const core = mesh.userData.core;
                if (core) {
                    const pulse = 0.85 + Math.sin(this.environmentPulse * 5.4 + offset) * 0.18;
                    core.scale.setScalar(0.9 * (0.6 + health * 0.6) * pulse);
                }
            } else if (mesh.userData.isActive) {
                if (mesh.material && mesh.material.emissiveIntensity) {
                    mesh.material.emissiveIntensity = 0.5 + Math.sin(this.environmentPulse * 2.5) * 0.2;
                }
            }
        });

        if (typeof this.renderer.renderAsync === 'function') {
            this.renderer.renderAsync(this.scene, this.camera);
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }
}
