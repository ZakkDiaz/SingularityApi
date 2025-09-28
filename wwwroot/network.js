// network.js
import { log } from './utils.js';

const DEFAULT_RECONNECT_DELAY = 1500;
const MAX_RECONNECT_DELAY = 12000;

export class Network {
    constructor(callbacks = {}) {
        this.callbacks = callbacks;
        this.socket = null;
        this.playerId = null;
        this.desiredUrl = null;
        this.reconnectDelay = DEFAULT_RECONNECT_DELAY;
        this.reconnectTimer = null;
    }

    connect(url) {
        this.desiredUrl = url;
        this.clearReconnect();
        this.openSocket();
    }

    openSocket() {
        if (!this.desiredUrl) {
            throw new Error('WebSocket url not set');
        }

        log(`Connecting to ${this.desiredUrl}…`);
        this.socket = new WebSocket(this.desiredUrl);

        this.socket.onopen = () => {
            log('WebSocket connected.');
            this.reconnectDelay = DEFAULT_RECONNECT_DELAY;
            if (this.callbacks.onSocketOpen) {
                this.callbacks.onSocketOpen();
            }
        };

        this.socket.onerror = (err) => {
            log(`WebSocket error: ${err.message ?? err}`);
        };

        this.socket.onclose = () => {
            log('WebSocket disconnected.');
            this.socket = null;
            this.scheduleReconnect();
            if (this.callbacks.onSocketClosed) {
                this.callbacks.onSocketClosed();
            }
        };

        this.socket.onmessage = (evt) => {
            try {
                const data = JSON.parse(evt.data);
                this.handleServerMessage(data);
            } catch (e) {
                log(`Error parsing message: ${e}`);
            }
        };
    }

    scheduleReconnect() {
        if (!this.desiredUrl || this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
            this.openSocket();
        }, this.reconnectDelay);
    }

    clearReconnect() {
        if (this.reconnectTimer) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    handleServerMessage(data) {
        switch (data.type) {
            case 'initialState':
                this.playerId = data.playerId;
                if (this.callbacks.onInitialState) {
                    this.callbacks.onInitialState(data);
                }
                break;

            case 'playerState':
                if (this.callbacks.onPlayerState) {
                    this.callbacks.onPlayerState(data.player);
                }
                break;

            case 'playerJoined':
                if (this.callbacks.onPlayerJoined) {
                    this.callbacks.onPlayerJoined(data.player);
                }
                break;

            case 'playerLeft':
                if (this.callbacks.onPlayerLeft) {
                    this.callbacks.onPlayerLeft(data.playerId);
                }
                break;

            case 'nearbyChunksResponse':
                if (this.callbacks.onNearbyChunks) {
                    this.callbacks.onNearbyChunks(
                        data.chunks ?? [],
                        data.chunkSize,
                        data.centerChunkX,
                        data.centerChunkZ
                    );
                }
                break;

            case 'environmentUpdate':
                if (this.callbacks.onEnvironmentUpdate) {
                    this.callbacks.onEnvironmentUpdate(data.environmentObject);
                }
                break;

            case 'worldTick':
                if (this.callbacks.onWorldTick) {
                    this.callbacks.onWorldTick(data);
                }
                break;

            case 'playerStats':
                if (this.callbacks.onPlayerStats) {
                    this.callbacks.onPlayerStats(data);
                }
                break;

            case 'mobUpdate':
                if (this.callbacks.onMobUpdate) {
                    this.callbacks.onMobUpdate(data.mobs ?? []);
                }
                break;

            case 'mobAttack':
                if (this.callbacks.onMobAttack) {
                    this.callbacks.onMobAttack(data);
                }
                break;

            case 'playerAbility':
                if (this.callbacks.onPlayerAbility) {
                    this.callbacks.onPlayerAbility(data);
                }
                break;

            default:
                log(`Unknown message type: ${data.type}`);
                break;
        }
    }

    requestNearbyChunks(radius) {
        if (!this.isOpen()) {
            log('Socket not open yet, skipping chunk request…');
            return;
        }
        this.send({ type: 'requestNearbyChunks', radius });
    }

    sendPlayerTransform(transform) {
        if (!this.isOpen()) {
            return;
        }
        this.send({ type: 'playerTransform', ...transform });
    }

    sendInteraction(targetId) {
        if (!this.isOpen() || !targetId) {
            return;
        }
        this.send({ type: 'interact', targetId, environmentId: targetId });
    }

    sendAbilityUse(abilityId, targetId) {
        if (!this.isOpen() || !abilityId) {
            return;
        }
        const payload = { type: 'useSkill', abilityId };
        if (targetId) {
            payload.targetId = targetId;
            payload.environmentId = targetId;
        }
        this.send(payload);
    }

    sendStatUpgrade(statId) {
        if (!this.isOpen() || !statId) {
            return;
        }
        this.send({ type: 'upgradeStat', statId });
    }

    sendWeaponChoice(abilityId) {
        if (!this.isOpen() || !abilityId) {
            return;
        }
        this.send({ type: 'chooseWeapon', abilityId });
    }

    send(payload) {
        if (!this.isOpen()) {
            return;
        }
        try {
            this.socket.send(JSON.stringify(payload));
        } catch (err) {
            log(`Failed to send payload: ${err}`);
        }
    }

    isOpen() {
        return this.socket && this.socket.readyState === WebSocket.OPEN;
    }
}
