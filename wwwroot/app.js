// app.js
import { log } from './utils.js';
import { Network } from './network.js';
import { World } from './world.js';
import { Player } from './player.js';

let network, world, player;

function init() {
    log("Initializing app.js...");

    // 1) Create the World
    world = new World();

    // 2) Create the Player
    player = new Player(world.scene, world.camera);

    // 3) Create the Network
    network = new Network({
        onPlayerUpdate: (x, y, z) => {
            player.setPosition(x, y, z);
        },
        onNearbyChunks: (chunks, chunkSize, centerChunkX, centerChunkZ) => {
            chunks.forEach((chunk) => {
                world.addOrUpdateChunk(chunk.x, chunk.z, chunkSize, chunk.vertices);
            });
            world.cleanupDistantChunks(player.getPosition(), 128);
        },
        onSocketOpen: () => {
            log("Socket is open => request initial chunks now.");
            network.requestNearbyChunks(1);
        },
    });

    // Connect to server
    network.connect("wss://singularityapi20250124105559.azurewebsites.net//ws");

    // Start the render loop
    animate();
}

function animate() {
    requestAnimationFrame(animate);

    // 1) Update local movement
    player.update(); // or a real ground function

    // 2) Possibly send net movement each frame or in intervals
    player.sendMovementToServerIfNeeded(network);

    // 3) Render
    world.render();
}

window.addEventListener('load', init);
