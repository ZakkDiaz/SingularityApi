// app.js
import { log } from './utils.js';
import { Network } from './network.js';
import { World } from './world.js';
import { Player } from './player.js';

// One set of shared handles used by both init() and animate()
let world;
let network;
let player;

function init() {
    log('Initializing app.js…');

    // 1) Create the world
    world = new World();
    const TOLERANCE = 100;   // 0.1 world-units ≈ 10 cm if 1 unit = 1 m

    
    // 2) Create the network first so we can hand it to the player
    network = new Network({
        onPlayerUpdate: (x, y, z) => {
            const current = player.getPosition();      // { x, y, z }

            // If the vertical gap is tiny, preserve the local y to avoid jitter
            const correctedX = Math.abs(x - current.x) > TOLERANCE ? x : current.x;
            const correctedZ = Math.abs(z - current.z) > TOLERANCE ? z : current.z;
            const correctedY = Math.abs(y - current.y) > TOLERANCE ? y : current.y;

            player.setPosition(correctedX, correctedY, correctedZ);
        },
        onNearbyChunks: (chunks, chunkSize, cx, cz) => {
            chunks.forEach(c =>
                world.addOrUpdateChunk(c.x, c.z, chunkSize, c.vertices)
            );
            world.cleanupDistantChunks(player.getPosition(), 128);
        },
        onSocketOpen: () => {
            log('Socket open → seeding initial area');
            network.requestNearbyChunks(1);   // radius = 1 chunk
        }
    });

    // 3) Create the player and give it the network so it can request chunks
    player = new Player(world.scene, world.camera, network);

    // 4) Connect and start the render loop
    network.connect('wss://singularityapi20250124105559.azurewebsites.net/ws');
    requestAnimationFrame(animate);
}

function animate() {
    requestAnimationFrame(animate);

    // Local movement
    player.update();
    player.sendMovementToServerIfNeeded(network);

    // Render
    world.render();
}

window.addEventListener('load', init);
