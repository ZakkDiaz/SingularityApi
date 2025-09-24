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
let abilityUi;

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
    abilityUi = {
        container: document.getElementById('abilityBar'),
        slots: new Map()
    };

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
            if (Array.isArray(state.abilities)) {
                applyAbilities(state.abilities);
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
                world.syncChunkMobs(chunk.x, chunk.z, chunk.mobs || []);
            });
            const cleanupDistance = (effectiveChunkSize ?? 16) * 8;
            world.cleanupDistantChunks(player.getPosition(), cleanupDistance);
            player.setChunkSize(effectiveChunkSize);
        },
        onEnvironmentUpdate: (environmentObject) => {
            world.updateEnvironmentObject(environmentObject);
        },
        onMobUpdate: (mobs) => {
            world.applyMobUpdate(mobs);
        },
        onMobAttack: (attack) => {
            if (attack && attack.mobId) {
                world.playMobAttack(attack.mobId, attack.targetId);
            }
        },
        onPlayerAbility: (payload) => {
            if (!payload) {
                return;
            }
            world.playPlayerAbility(payload.playerId, payload.abilityId);
        },
        onWorldTick: (timeOfDay) => {
            world.updateWorldTime(timeOfDay);
            updateTimeHud(timeOfDay);
        },
        onPlayerStats: (payload) => {
            if (payload && payload.stats) {
                updateStatsHud(payload.stats, payload);
            }
            if (payload && Array.isArray(payload.abilities)) {
                applyAbilities(payload.abilities);
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
    if (abilityUi && player) {
        refreshAbilityCooldowns(player.getAbilityStates());
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

function applyAbilities(abilities) {
    if (!Array.isArray(abilities)) {
        return;
    }
    updateAbilityBar(abilities);
    if (player) {
        player.setAbilities(abilities);
    }
}

function updateAbilityBar(abilities) {
    if (!abilityUi || !abilityUi.container) {
        return;
    }

    const seen = new Set();
    abilities.forEach(ability => {
        if (!ability || !ability.id) {
            return;
        }
        seen.add(ability.id);
        let slot = abilityUi.slots.get(ability.id);
        if (!slot) {
            slot = createAbilitySlot(ability);
            abilityUi.container.appendChild(slot);
            abilityUi.slots.set(ability.id, slot);
        }

        const nameEl = slot.querySelector('.ability-name');
        const keyEl = slot.querySelector('.ability-key');
        if (nameEl) {
            nameEl.textContent = ability.name || ability.id;
        }
        if (keyEl) {
            keyEl.textContent = ability.key || '';
        }
        slot.classList.toggle('locked', !ability.unlocked);
    });

    for (const [id, slot] of abilityUi.slots.entries()) {
        if (!seen.has(id)) {
            slot.remove();
            abilityUi.slots.delete(id);
        }
    }

    if (abilities.length > 0) {
        abilityUi.container.classList.add('visible');
    }
}

function refreshAbilityCooldowns(abilityStates) {
    if (!abilityUi || !abilityUi.container || !Array.isArray(abilityStates)) {
        return;
    }

    abilityStates.forEach(state => {
        if (!state || !state.id) {
            return;
        }
        const slot = abilityUi.slots.get(state.id);
        if (!slot) {
            return;
        }
        const fill = slot.querySelector('.cooldown-fill');
        const text = slot.querySelector('.cooldown-text');
        const cooldown = typeof state.cooldown === 'number' ? state.cooldown : 0;
        const remaining = typeof state.cooldownRemaining === 'number' ? state.cooldownRemaining : 0;
        const percent = cooldown > 0 ? Math.min(1, remaining / cooldown) : 0;
        if (fill) {
            fill.style.transform = `scaleY(${percent})`;
            fill.style.opacity = percent > 0 ? '0.7' : '0';
        }
        if (text) {
            text.textContent = percent > 0.05 ? Math.ceil(remaining).toString() : '';
        }
        slot.classList.toggle('locked', !state.unlocked);
        slot.classList.toggle('ready', state.unlocked && percent <= 0.01);
    });
}

function createAbilitySlot(ability) {
    const slot = document.createElement('div');
    slot.className = 'ability-slot';
    slot.dataset.abilityId = ability.id;

    const fill = document.createElement('div');
    fill.className = 'cooldown-fill';
    slot.appendChild(fill);

    const text = document.createElement('div');
    text.className = 'cooldown-text';
    slot.appendChild(text);

    const key = document.createElement('div');
    key.className = 'ability-key';
    key.textContent = ability.key || '';
    slot.appendChild(key);

    const label = document.createElement('div');
    label.className = 'ability-name';
    label.textContent = ability.name || ability.id;
    slot.appendChild(label);

    if (ability && ability.unlocked === false) {
        slot.classList.add('locked');
    }

    return slot;
}

function getPhaseLabel(timeOfDay) {
    if (timeOfDay < 0.2) return 'Dawn';
    if (timeOfDay < 0.45) return 'Day';
    if (timeOfDay < 0.7) return 'Dusk';
    return 'Night';
}

window.addEventListener('load', init);
