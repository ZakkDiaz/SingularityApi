// app.js
import { log } from './utils.js';
import { Network } from './network.js';
import { World } from './world.js';
import { Player } from './player.js';

let world;
let network;
let player;
let hudTime;
let statsElements;
let levelToast;
let levelToastTimer = null;

function init() {
    log('Initializing Singularity world…');

    world = new World();
    hudTime = document.getElementById('timeOfDay');
    statsElements = {
        level: document.getElementById('statLevel'),
        attack: document.getElementById('statAttack'),
        health: document.getElementById('statHealth'),
        xpText: document.getElementById('xpText'),
        xpFill: document.getElementById('xpFill'),
        panel: document.getElementById('statsPanel')
    };
    levelToast = document.getElementById('levelToast');

    network = new Network({
        onSocketOpen: () => {
            log('Socket open → requesting surrounding chunks');
            network.requestNearbyChunks(2);
        },
        onInitialState: (state) => {
            log(`Connected as ${state.playerId}`);
            network.playerId = state.playerId;
            world.setLocalPlayerId(state.playerId);
            if (state.players) {
                state.players.forEach(snapshot => world.upsertRemotePlayer(snapshot));
            }
            if (typeof state.timeOfDay === 'number') {
                world.updateWorldTime(state.timeOfDay);
                updateTimeHud(state.timeOfDay);
            }
            player.setPlayerId(state.playerId);
            if (state.stats) {
                updateStatsHud(state.stats);
            }
        },
        onPlayerState: (snapshot) => {
            if (!snapshot) return;
            if (snapshot.playerId === network.playerId) {
                player.applyAuthoritativeState(snapshot);
            } else {
                world.upsertRemotePlayer(snapshot);
            }
        },
        onPlayerJoined: (snapshot) => {
            world.upsertRemotePlayer(snapshot);
        },
        onPlayerLeft: (playerId) => {
            world.removeRemotePlayer(playerId);
        },
        onNearbyChunks: (chunks, chunkSize) => {
            const effectiveChunkSize = chunkSize ?? player.getChunkSize();
            chunks.forEach(chunk => {
                world.addOrUpdateChunk(chunk.x, chunk.z, effectiveChunkSize, chunk.vertices);
                world.updateEnvironmentForChunk(chunk.x, chunk.z, chunk.environmentObjects || []);
            });
            const cleanupDistance = (effectiveChunkSize ?? 16) * 8;
            world.cleanupDistantChunks(player.getPosition(), cleanupDistance);
            player.setChunkSize(effectiveChunkSize);
        },
        onEnvironmentUpdate: (environmentObject) => {
            world.updateEnvironmentObject(environmentObject);
        },
        onWorldTick: (timeOfDay) => {
            world.updateWorldTime(timeOfDay);
            updateTimeHud(timeOfDay);
        },
        onPlayerStats: (payload) => {
            if (payload && payload.stats) {
                updateStatsHud(payload.stats, payload);
            }
        }
    });

    const pointerPrompt = document.getElementById('pointerPrompt');
    player = new Player(world, network, () => {
        if (pointerPrompt) {
            pointerPrompt.classList.add('hidden');
        }
    });

    const url = resolveWebSocketUrl();
    network.connect(url);

    requestAnimationFrame(animate);
}

function animate() {
    requestAnimationFrame(animate);
    if (player) {
        player.update();
        player.sendMovementToServerIfNeeded();
    }
    if (world) {
        world.render();
    }
}

function resolveWebSocketUrl() {
    if (window.SINGULARITY_WS_URL) {
        return window.SINGULARITY_WS_URL;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
}

function updateTimeHud(timeOfDay) {
    if (!hudTime || typeof timeOfDay !== 'number') {
        return;
    }
    const totalMinutes = Math.floor((timeOfDay % 1) * 24 * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    const phase = getPhaseLabel(timeOfDay);
    hudTime.textContent = `${hours.toString().padStart(2, '0')}:${minutes
        .toString()
        .padStart(2, '0')} · ${phase}`;
}

function updateStatsHud(stats, context = {}) {
    if (!statsElements || !stats) {
        return;
    }

    if (statsElements.panel) {
        statsElements.panel.classList.add('visible');
    }

    if (statsElements.level) {
        statsElements.level.textContent = stats.level ?? 1;
    }
    if (statsElements.attack) {
        statsElements.attack.textContent = stats.attack ?? 0;
    }
    if (statsElements.health) {
        const current = stats.currentHealth ?? stats.maxHealth ?? 0;
        const max = stats.maxHealth ?? current;
        statsElements.health.textContent = `${current} / ${max}`;
    }
    if (statsElements.xpText) {
        if (stats.experienceToNext && stats.experienceToNext > 0) {
            statsElements.xpText.textContent = `${stats.experience ?? 0} / ${stats.experienceToNext} XP`;
        } else {
            statsElements.xpText.textContent = `${stats.experience ?? 0} XP`;
        }
    }
    if (statsElements.xpFill) {
        const denom = stats.experienceToNext ?? 0;
        const percent = denom > 0 ? Math.min(1, (stats.experience ?? 0) / denom) : 1;
        const clamped = Math.max(0.08, percent);
        statsElements.xpFill.style.width = `${clamped * 100}%`;
    }

    if (context && typeof context.xpAwarded === 'number' && context.xpAwarded > 0) {
        const suffix = context.reason ? ` · ${context.reason}` : '';
        log(`+${context.xpAwarded} XP${suffix}`);
    }

    if (context && context.leveledUp) {
        log(`Level up! You reached level ${stats.level}. Attack ${stats.attack}.`);
        showLevelToast(`Level ${stats.level}`);
    }
}

function showLevelToast(message) {
    if (!levelToast) {
        return;
    }
    levelToast.textContent = message;
    levelToast.classList.add('visible');
    if (levelToastTimer) {
        window.clearTimeout(levelToastTimer);
    }
    levelToastTimer = window.setTimeout(() => {
        if (levelToast) {
            levelToast.classList.remove('visible');
        }
        levelToastTimer = null;
    }, 2200);
}

function getPhaseLabel(timeOfDay) {
    if (timeOfDay < 0.2) return 'Dawn';
    if (timeOfDay < 0.45) return 'Day';
    if (timeOfDay < 0.7) return 'Dusk';
    return 'Night';
}

window.addEventListener('load', init);
