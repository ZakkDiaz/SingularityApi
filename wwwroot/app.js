// app.js
import { log } from './utils.js';
import { Network } from './network.js';
import { World } from './world.js';
import { Player } from './player.js';
import { createBaselineAbilitySnapshots } from './abilities.js';

let world;
let network;
let player;
let hudElements;
let abilityUi;
let levelToast;
let levelToastTimer = null;
let debugElements;
let debugEnabled = false;

const baselineStats = {
    level: 1,
    attack: 8,
    maxHealth: 120,
    currentHealth: 120,
    experience: 0,
    experienceToNext: 80
};

function init() {
    world = new World();
    player = new Player(world, null);
    hudElements = {
        level: document.getElementById('levelValue'),
        attack: document.getElementById('attackValue'),
        health: document.getElementById('healthValue'),
        xpText: document.getElementById('xpText'),
        xpFill: document.getElementById('xpFill'),
        time: document.getElementById('timeOfDay')
    };
    levelToast = document.getElementById('levelToast');
    abilityUi = {
        container: document.getElementById('abilityBar'),
        slots: new Map()
    };
    debugElements = {
        panel: document.getElementById('debugPanel'),
        ability: document.getElementById('debugAbility'),
        range: document.getElementById('debugRange'),
        nearest: document.getElementById('debugNearest'),
        nearestDistance: document.getElementById('debugDistance'),
        target: document.getElementById('debugTarget'),
        targetDistance: document.getElementById('debugTargetDistance')
    };

    network = new Network({
        onSocketOpen: () => {
            log('Connected to game server.');
            network.requestNearbyChunks(1);
        },
        onInitialState: (state) => {
            network.playerId = state.playerId;
            world.setLocalPlayerId(state.playerId);
            player.setPlayerId(state.playerId);

            log(`Joined world as ${state.playerId}`);

            (state.players ?? []).forEach(snapshot => world.upsertRemotePlayer(snapshot));

            if (typeof state.timeOfDay === 'number') {
                world.updateWorldTime(state.timeOfDay);
                updateTimeHud(state.timeOfDay);
            }

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
            if (!snapshot) return;
            world.upsertRemotePlayer(snapshot);
            log(`${snapshot.displayName ?? 'Player'} joined nearby.`);
        },
        onPlayerLeft: (playerId) => {
            world.removeRemotePlayer(playerId);
            log(`Player ${playerId} disconnected.`);
        },
        onNearbyChunks: (chunks) => {
            world.ingestChunks(chunks ?? []);
        },
        onMobUpdate: (mobs) => {
            world.applyMobUpdate(mobs);
        },
        onMobAttack: (attack) => {
            if (attack?.mobId) {
                world.playMobAttack(attack.mobId);
            }
        },
        onPlayerAbility: (payload) => {
            if (!payload) return;
            world.setHighlightedMob(payload.targetId ?? null);
        },
        onWorldTick: (timeOfDay) => {
            world.updateWorldTime(timeOfDay);
            updateTimeHud(timeOfDay);
        },
        onPlayerStats: (payload) => {
            if (payload?.stats) {
                updateStatsHud(payload.stats);
            }
            if (payload?.abilities) {
                applyAbilities(payload.abilities);
            }
            if (payload?.reason) {
                log(payload.reason);
            }
            if (payload?.xpAwarded) {
                log(`Gained ${payload.xpAwarded} XP.`);
            }
            if (payload?.leveledUp) {
                showLevelToast(`Level ${payload.stats?.level ?? ''}!`);
            }
        }
    });

    player.network = network;

    updateStatsHud(baselineStats);
    applyAbilities(createBaselineAbilitySnapshots());

    const url = resolveWebSocketUrl();
    network.connect(url);

    window.addEventListener('keydown', handleGlobalKeyDown);
    world.setDebugMode(debugEnabled);

    requestAnimationFrame(animate);
}

function animate() {
    requestAnimationFrame(animate);
    let debugSnapshot = null;

    if (player) {
        player.update();
        player.sendMovementToServerIfNeeded();
        debugSnapshot = player.getDebugSnapshot();
    }
    if (world) {
        world.render(debugSnapshot);
    }
    if (player && abilityUi) {
        refreshAbilityCooldowns(player.getAbilityStates());
    }
    if (debugEnabled) {
        updateDebugPanel(debugSnapshot);
    }
}

function resolveWebSocketUrl() {
    if (window.SINGULARITY_WS_URL) {
        return window.SINGULARITY_WS_URL;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/ws`;
}

function updateStatsHud(stats) {
    if (!hudElements) return;
    hudElements.level.textContent = stats.level ?? baselineStats.level;
    hudElements.attack.textContent = stats.attack ?? baselineStats.attack;
    hudElements.health.textContent = `${stats.currentHealth ?? baselineStats.currentHealth} / ${stats.maxHealth ?? baselineStats.maxHealth}`;

    const currentXp = stats.experience ?? baselineStats.experience;
    const xpToNext = stats.experienceToNext ?? baselineStats.experienceToNext;
    const fraction = xpToNext > 0 ? Math.min(1, currentXp / xpToNext) : 0;
    hudElements.xpFill.style.width = `${Math.round(fraction * 100)}%`;
    hudElements.xpText.textContent = `${currentXp} / ${xpToNext} XP`;
}

function updateTimeHud(timeOfDay) {
    if (!hudElements?.time) return;
    const totalMinutes = (timeOfDay ?? 0) * 24 * 60;
    const hours = Math.floor(totalMinutes / 60) % 24;
    const minutes = Math.floor(totalMinutes % 60);
    const label = hours >= 6 && hours < 18 ? 'Day' : 'Night';
    hudElements.time.textContent = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')} · ${label}`;
}

function applyAbilities(abilities) {
    if (!Array.isArray(abilities)) {
        return;
    }
    player.setAbilitySnapshots(abilities);

    const container = abilityUi.container;
    if (!container) return;

    abilities.forEach(ability => {
        const id = ability.abilityId ?? ability.id;
        if (!id) {
            return;
        }
        let slot = abilityUi.slots.get(id);
        if (!slot) {
            slot = createAbilitySlot();
            abilityUi.slots.set(id, slot);
            container.appendChild(slot.root);
        }
        slot.name.textContent = ability.name ?? id;
        slot.root.dataset.locked = ability.unlocked ? 'false' : 'true';
        slot.root.dataset.available = ability.available ? 'true' : 'false';
        slot.root.dataset.autocast = (ability.autoCast ?? true) ? 'true' : 'false';
    });

    refreshAbilityCooldowns(player.getAbilityStates());
}

function createAbilitySlot() {
    const root = document.createElement('div');
    root.className = 'ability-slot';
    const key = document.createElement('span');
    key.className = 'ability-key';
    const name = document.createElement('span');
    name.className = 'ability-name';
    const cooldown = document.createElement('span');
    cooldown.className = 'ability-cooldown';
    root.appendChild(key);
    root.appendChild(name);
    root.appendChild(cooldown);
    return { root, key, name, cooldown };
}

function refreshAbilityCooldowns(abilityStates) {
    if (!Array.isArray(abilityStates)) {
        return;
    }
    abilityStates.forEach(state => {
        const slot = abilityUi.slots.get(state.id);
        if (!slot) return;
        slot.name.textContent = state.name ?? state.id;
        slot.key.textContent = state.autoCast ? 'AUTO' : '';
        if (state.ready) {
            slot.root.dataset.available = 'true';
            slot.cooldown.textContent = 'Ready';
        } else {
            slot.root.dataset.available = 'false';
            const remaining = Math.max(0, state.cooldownRemaining);
            slot.cooldown.textContent = remaining >= 1 ? `${Math.ceil(remaining)}s` : `${remaining.toFixed(1)}s`;
        }
        slot.root.dataset.locked = state.unlocked ? 'false' : 'true';
        slot.root.dataset.autocast = state.autoCast ? 'true' : 'false';
    });
}

function handleGlobalKeyDown(evt) {
    if (evt.code === 'F3') {
        debugEnabled = !debugEnabled;
        world.setDebugMode(debugEnabled);
        if (!debugEnabled) {
            updateDebugPanel(null);
        } else {
            updateDebugPanel(player?.getDebugSnapshot() ?? null);
        }
        log(`Debug mode ${debugEnabled ? 'enabled' : 'disabled'}.`);
    }
}

function updateDebugPanel(info) {
    if (!debugElements?.panel) {
        return;
    }

    debugElements.panel.dataset.active = debugEnabled ? 'true' : 'false';

    const abilityText = info?.abilityName || info?.abilityId || '—';
    const rangeText = typeof info?.abilityRange === 'number' ? `${info.abilityRange.toFixed(1)}m` : '—';
    const nearestId = info?.nearestMobId || 'None';
    const nearestDistance = typeof info?.nearestDistance === 'number' ? `${info.nearestDistance.toFixed(2)}m` : '—';
    const targetId = info?.targetId || 'None';
    const targetDistance = typeof info?.targetDistance === 'number' ? `${info.targetDistance.toFixed(2)}m` : '—';

    if (debugElements.ability) debugElements.ability.textContent = abilityText;
    if (debugElements.range) debugElements.range.textContent = rangeText;
    if (debugElements.nearest) debugElements.nearest.textContent = nearestId;
    if (debugElements.nearestDistance) debugElements.nearestDistance.textContent = nearestDistance;
    if (debugElements.target) debugElements.target.textContent = targetId;
    if (debugElements.targetDistance) debugElements.targetDistance.textContent = targetDistance;
}

function showLevelToast(text) {
    if (!levelToast) return;
    levelToast.textContent = text;
    levelToast.classList.add('visible');
    if (levelToastTimer) {
        window.clearTimeout(levelToastTimer);
    }
    levelToastTimer = window.setTimeout(() => {
        levelToast.classList.remove('visible');
    }, 3000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
