// world.js
import { log } from './utils.js';

export class World {
    constructor() {
        // 1) Scene
        this.scene = new THREE.Scene();

        // 2) Camera
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
        this.camera.position.set(0, 5, 10);

        // 3) Lights
        const dirLight = new THREE.DirectionalLight(0xffffff, 1);
        dirLight.position.set(30, 50, 30);
        this.scene.add(dirLight);

        const ambLight = new THREE.AmbientLight(0xffffff, 0.3);
        this.scene.add(ambLight);

        // 4) Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        document.body.appendChild(this.renderer.domElement);

        // 5) chunk meshes
        this.chunkMeshes = new Map();

        // handle resize
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    addOrUpdateChunk(cx, cz, chunkSize, vertexList) {
        const totalVerts = (chunkSize + 1) * (chunkSize + 1);
        if (vertexList.length !== totalVerts) {
            log(`Chunk mismatch: got ${vertexList.length} vs expected ${totalVerts} for chunk (${cx},${cz})`);
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
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
        geometry.computeVertexNormals();

        const material = new THREE.MeshLambertMaterial({
            color: 0x88cc88,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.cx = cx;
        mesh.userData.cz = cz;

        const chunkKey = `${cx},${cz}`;
        if (this.chunkMeshes.has(chunkKey)) {
            this.scene.remove(this.chunkMeshes.get(chunkKey));
        }
        this.chunkMeshes.set(chunkKey, mesh);
        this.scene.add(mesh);
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
                // log(`Removed chunk ${key} at dist ${dist.toFixed(2)}`);
            }
        });
    }

    // Called each frame
    render() {
        this.renderer.render(this.scene, this.camera);
    }
}
