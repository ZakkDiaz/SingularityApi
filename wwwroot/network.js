// network.js
import { log } from './utils.js';

export class Network {
    constructor(callbacks) {
        this.callbacks = callbacks || {};
        this.socket = null;
    }

    connect(url) {
        this.socket = new WebSocket(url);

        this.socket.onopen = () => {
            log("WebSocket connected.");

            // Now that it's OPEN, we can safely request initial chunks if we want
            // or you can do it in app.js after onopen => callbacks
            if (this.callbacks.onSocketOpen) {
                this.callbacks.onSocketOpen();
            }
        };

        this.socket.onerror = (err) => {
            log("WebSocket error: " + err.message);
        };

        this.socket.onclose = () => {
            log("WebSocket disconnected.");
            this.socket = null;
        };

        this.socket.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);
                this.handleServerMessage(data);
            } catch (e) {
                log("Error parsing message: " + e);
            }
        };
    }

    handleServerMessage(data) {
        switch (data.type) {
            case "playerUpdate":
                if (this.callbacks.onPlayerUpdate) {
                    this.callbacks.onPlayerUpdate(data.x, data.y, data.z);
                }
                break;

            case "nearbyChunksResponse":
                if (this.callbacks.onNearbyChunks) {
                    this.callbacks.onNearbyChunks(
                        data.chunks,
                        data.chunkSize,
                        data.centerChunkX,
                        data.centerChunkZ
                    );
                }
                break;

            default:
                log(`Unknown message type: ${data.type}`);
                break;
        }
    }

    requestNearbyChunks(radius) {
        // Ensure socket is open
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            log("Socket not open yet, skipping chunk request...");
            return;
        }
        const msg = { type: "requestNearbyChunks", radius };
        this.socket.send(JSON.stringify(msg));
    }

    sendPlayerMove(dx, dz, y) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return;
        }
        const msg = {
            type: "playerMove",
            dx,
            dz,
            y
        };

        this.socket.send(JSON.stringify(msg));
    }
}
