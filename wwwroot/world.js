// world.js
import { log } from './utils.js';

const CHUNK_MATERIAL = new THREE.MeshStandardMaterial({
    color: 0x6ea07c,
    roughness: 0.85,
    metalness: 0.0,
    flatShading: false
});

export class World {
    constructor() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1e2232);
        this.scene.fog = new THREE.FogExp2(0x1e2232, 0.003);

        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 3000);
        this.camera.position.set(0, 8, 12);

        this.clock = new THREE.Clock();
        this.lastDelta = 0.016;

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.shadowMap.enabled = true;
        document.body.appendChild(this.renderer.domElement);

        this.directionalLight = new THREE.DirectionalLight(0xf7f5e9, 0.9);
        this.directionalLight.position.set(60, 100, 40);
        this.directionalLight.castShadow = true;
        this.scene.add(this.directionalLight);

        this.ambientLight = new THREE.HemisphereLight(0x9cc4ff, 0x1a2233, 0.35);
        this.scene.add(this.ambientLight);

        this.chunkMeshes = new Map();
        this.environmentMeshes = new Map();
        this.chunkEnvironmentIndex = new Map();
        this.remotePlayers = new Map();
        this.localPlayerId = null;
        this.environmentPulse = 0;

        window.addEventListener('resize', () => this.handleResize());
        this.handleResize();
    }

    handleResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    setLocalPlayerId(id) {
        this.localPlayerId = id;
    }

    getDeltaSeconds() {
        return this.lastDelta;
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

    upsertRemotePlayer(snapshot) {
        if (!snapshot || !snapshot.playerId || snapshot.playerId === this.localPlayerId) {
            return;
        }

        let record = this.remotePlayers.get(snapshot.playerId);
        if (!record) {
            const group = this.buildRemoteAvatar(snapshot.displayName);
            this.scene.add(group);
            record = {
                mesh: group,
                targetPosition: new THREE.Vector3(),
                targetHeading: 0
            };
            this.remotePlayers.set(snapshot.playerId, record);
        }

        record.targetPosition.set(snapshot.x, snapshot.y, snapshot.z);
        record.targetHeading = snapshot.heading ?? 0;
        record.mesh.userData.displayName = snapshot.displayName ?? 'Wanderer';
    }

    buildRemoteAvatar(displayName) {
        const group = new THREE.Group();
        const bodyGeo = new THREE.CapsuleGeometry(0.35, 1.1, 8, 16);
        const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a8fb2, metalness: 0.1, roughness: 0.5 });
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.castShadow = true;
        body.receiveShadow = true;
        group.add(body);

        const visorGeo = new THREE.SphereGeometry(0.28, 12, 12, 0, Math.PI * 2, 0, Math.PI / 1.2);
        const visorMat = new THREE.MeshStandardMaterial({ color: 0x1e2b44, metalness: 0.4, roughness: 0.3 });
        const visor = new THREE.Mesh(visorGeo, visorMat);
        visor.position.set(0, 0.5, 0.35);
        group.add(visor);

        return group;
    }

    removeRemotePlayer(playerId) {
        const record = this.remotePlayers.get(playerId);
        if (!record) {
            return;
        }
        if (record.mesh.parent) {
            record.mesh.parent.remove(record.mesh);
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

        this.remotePlayers.forEach(record => {
            record.mesh.position.lerp(record.targetPosition, 1 - Math.exp(-delta * 6));
            const current = record.mesh.rotation.y;
            const target = record.targetHeading;
            record.mesh.rotation.y = THREE.MathUtils.lerp(current, target, 1 - Math.exp(-delta * 6));
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

        this.renderer.render(this.scene, this.camera);
    }
}
