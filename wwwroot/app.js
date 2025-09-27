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
let upgradeUi;
let upgradeSelectionPending = false;

const baselineStats = {
    level: 1,
    attack: 8,
    maxHealth: 120,
    currentHealth: 120,
    experience: 0,
    experienceToNext: 80,
    attackSpeed: 1.0,
    unspentStatPoints: 0
};

let latestStats = { ...baselineStats };

const DEFAULT_UPGRADE_OPTIONS = [
    { id: 'attack', name: 'Power', description: '+2 attack' },
    { id: 'maxHealth', name: 'Vitality', description: '+10 max health' },
    { id: 'attackSpeed', name: 'Finesse', description: '10% faster attacks' }
];

function init() {
    world = new World();
    player = new Player(world, null);
    hudElements = {
        level: document.getElementById('levelValue'),
        attack: document.getElementById('attackValue'),
        attackSpeed: document.getElementById('attackSpeedValue'),
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
    upgradeUi = {
        overlay: document.getElementById('upgradeOverlay'),
        options: document.getElementById('upgradeOptions'),
        remaining: document.getElementById('upgradeRemaining'),
        hint: document.getElementById('upgradeHint')
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
                const normalized = updateStatsHud(state.stats);
                handleUpgradeAvailability(state.upgradeOptions, normalized);
            }

            if (Array.isArray(state.abilities)) {
                applyAbilities(state.abilities);
            }
            else if (state.upgradeOptions) {
                handleUpgradeAvailability(state.upgradeOptions, latestStats);
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
            const normalized = payload?.stats ? updateStatsHud(payload.stats) : latestStats;
            handleUpgradeAvailability(payload?.upgradeOptions, normalized);
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
    hideUpgradeOptions();
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
    if (!hudElements) return latestStats;

    const normalized = {
        level: stats?.level ?? baselineStats.level,
        attack: stats?.attack ?? baselineStats.attack,
        maxHealth: stats?.maxHealth ?? baselineStats.maxHealth,
        currentHealth: stats?.currentHealth ?? baselineStats.currentHealth,
        experience: stats?.experience ?? baselineStats.experience,
        experienceToNext: stats?.experienceToNext ?? baselineStats.experienceToNext,
        attackSpeed: stats?.attackSpeed ?? baselineStats.attackSpeed,
        unspentStatPoints: stats?.unspentStatPoints ?? baselineStats.unspentStatPoints
    };

    const level = Math.round(normalized.level);
    const attack = Math.round(normalized.attack);
    const currentHealth = Math.round(normalized.currentHealth);
    const maxHealth = Math.round(normalized.maxHealth);
    const attackSpeed = typeof normalized.attackSpeed === 'number' ? normalized.attackSpeed : baselineStats.attackSpeed;
    const experience = Math.max(0, Math.round(normalized.experience));
    const experienceToNext = Math.max(0, Math.round(normalized.experienceToNext));

    hudElements.level.textContent = level;
    hudElements.attack.textContent = attack;
    hudElements.health.textContent = `${currentHealth} / ${maxHealth}`;

    if (hudElements.attackSpeed) {
        hudElements.attackSpeed.textContent = `${attackSpeed.toFixed(2)}x`;
    }

    const fraction = experienceToNext > 0 ? Math.min(1, experience / experienceToNext) : 0;
    hudElements.xpFill.style.width = `${Math.round(fraction * 100)}%`;
    hudElements.xpText.textContent = `${experience} / ${experienceToNext} XP`;

    latestStats = {
        level,
        attack,
        maxHealth,
        currentHealth,
        experience,
        experienceToNext,
        attackSpeed,
        unspentStatPoints: Math.max(0, Math.round(Number(normalized.unspentStatPoints ?? 0)))
    };

    if (player && typeof player.setStats === 'function') {
        player.setStats(latestStats);
    }

    return latestStats;
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

function handleUpgradeAvailability(options, stats = latestStats) {
    const remaining = stats?.unspentStatPoints ?? 0;
    if (remaining > 0) {
        showUpgradeOptions(options, remaining);
    } else {
        hideUpgradeOptions();
    }
}

function showUpgradeOptions(options, remainingPoints) {
    if (!upgradeUi?.overlay || !upgradeUi?.options || !upgradeUi?.remaining) {
        return;
    }

    const list = Array.isArray(options) && options.length > 0 ? options : DEFAULT_UPGRADE_OPTIONS;
    upgradeSelectionPending = false;
    upgradeUi.overlay.dataset.visible = 'true';
    upgradeUi.overlay.dataset.processing = 'false';
    upgradeUi.options.innerHTML = '';

    list.forEach(option => {
        const id = option?.id ?? option?.statId;
        if (!id) {
            return;
        }
        const name = option.name ?? id;
        const description = option.description ?? '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'upgrade-option';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'upgrade-name';
        nameSpan.textContent = name;
        const descSpan = document.createElement('span');
        descSpan.className = 'upgrade-desc';
        descSpan.textContent = description;
        button.appendChild(nameSpan);
        button.appendChild(descSpan);
        button.addEventListener('click', () => chooseUpgrade(id, name));
        upgradeUi.options.appendChild(button);
    });

    const label = remainingPoints > 1 ? `${remainingPoints} stat points available` : `${remainingPoints} stat point available`;
    upgradeUi.remaining.textContent = label;
    if (upgradeUi.hint) {
        upgradeUi.hint.textContent = 'Choose a stat to upgrade';
    }
}

function hideUpgradeOptions() {
    if (!upgradeUi?.overlay) {
        return;
    }
    upgradeSelectionPending = false;
    upgradeUi.overlay.dataset.visible = 'false';
    upgradeUi.overlay.dataset.processing = 'false';
    if (upgradeUi.options) {
        upgradeUi.options.innerHTML = '';
    }
    if (upgradeUi.remaining) {
        upgradeUi.remaining.textContent = '';
    }
    if (upgradeUi.hint) {
        upgradeUi.hint.textContent = '';
    }
}

function chooseUpgrade(statId, label) {
    if (!statId || upgradeSelectionPending) {
        return;
    }
    if (!network || typeof network.sendStatUpgrade !== 'function') {
        log('Unable to send upgrade selection right now.');
        return;
    }

    upgradeSelectionPending = true;
    if (upgradeUi?.overlay) {
        upgradeUi.overlay.dataset.processing = 'true';
    }
    if (upgradeUi?.hint) {
        upgradeUi.hint.textContent = 'Applying upgrade…';
    }
    if (upgradeUi?.options) {
        upgradeUi.options.querySelectorAll('button').forEach(button => {
            button.disabled = true;
        });
    }

    const labelText = label ?? statId;
    log(`Allocating stat point to ${labelText}.`);
    network.sendStatUpgrade(statId);
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
