// app.js
import { log } from './utils.js';
import { Network } from './network.js';
import { World } from './world.js';
import { Player } from './player.js';
import { createBaselineAbilitySnapshots, getAbilityDefaults } from './abilities.js';

let world;
let network;
let player;
let hudElements;
let abilityUi;
let levelToast;
let levelToastTimer = null;
let debugElements;
let debugEnabled = true;
let upgradeUi;
let upgradeSelectionPending = false;
let weaponUi;
let weaponSelectionPending = false;

const baselineStats = {
    level: 1,
    attack: 8,
    maxHealth: 120,
    currentHealth: 120,
    experience: 0,
    experienceToNext: 80,
    attackSpeed: 1.0,
    moveSpeed: 12,
    unspentStatPoints: 0,
    isEthereal: false
};

let latestStats = { ...baselineStats };

const STAT_UPGRADE_POOL = [
    { id: 'attack', name: 'Power', description: '+2 attack' },
    { id: 'maxHealth', name: 'Vitality', description: '+10 max health' },
    { id: 'attackSpeed', name: 'Finesse', description: '10% faster attacks' },
    { id: 'moveSpeed', name: 'Swiftness', description: '+1 move speed' }
];

function init() {
    world = new World();
    player = new Player(world, null);
    hudElements = {
        level: document.getElementById('levelValue'),
        attack: document.getElementById('attackValue'),
        attackSpeed: document.getElementById('attackSpeedValue'),
        moveSpeed: document.getElementById('moveSpeedValue'),
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
    weaponUi = {
        overlay: document.getElementById('weaponOverlay'),
        options: document.getElementById('weaponOptions'),
        hint: document.getElementById('weaponHint'),
        title: document.getElementById('weaponTitle')
    };
    debugElements = {
        panel: document.getElementById('debugPanel'),
        heading: document.getElementById('debugHeading'),
        headingRad: document.getElementById('debugHeadingRad'),
        cameraYaw: document.getElementById('debugCameraYaw'),
        cameraYawRad: document.getElementById('debugCameraYawRad'),
        position: document.getElementById('debugPosition'),
        velocity: document.getElementById('debugVelocity'),
        speed: document.getElementById('debugSpeed'),
        verticalVelocity: document.getElementById('debugVerticalVelocity'),
        groundHeight: document.getElementById('debugGroundHeight'),
        contactHeight: document.getElementById('debugContactHeight'),
        groundDistance: document.getElementById('debugGroundDistance'),
        stepHeight: document.getElementById('debugStepHeight'),
        grounded: document.getElementById('debugGrounded'),
        ethereal: document.getElementById('debugEthereal'),
        inputForward: document.getElementById('debugInputForward'),
        inputStrafe: document.getElementById('debugInputStrafe'),
        inputTurn: document.getElementById('debugInputTurn'),
        ability: document.getElementById('debugAbility'),
        range: document.getElementById('debugRange'),
        nearest: document.getElementById('debugNearest'),
        nearestDistance: document.getElementById('debugDistance'),
        target: document.getElementById('debugTarget'),
        targetDistance: document.getElementById('debugTargetDistance')
    };

    updateDebugPanel(player.getDebugSnapshot());

    network = new Network({
        onSocketOpen: () => {
            log('Connected to game server.');
            network.requestNearbyChunks(1);
        },
        onInitialState: (state) => {
            network.playerId = state.playerId;
            world.setLocalPlayerId(state.playerId);
            player.setPlayerId(state.playerId);

            if (state.terrain) {
                world.applyTerrainSnapshot(state.terrain);
            }

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

            handleWeaponChoices(state.weaponChoices);
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
            if (payload.attack) {
                world.spawnAttack(payload.attack);
            }
        },
        onWorldTick: (payload) => {
            const timeOfDay = payload?.timeOfDay ?? 0;
            world.updateWorldTime(timeOfDay);
            updateTimeHud(timeOfDay);
            if (payload?.attacks || payload?.completedAttackIds) {
                world.updateAttacks(payload?.attacks ?? [], payload?.completedAttackIds ?? []);
            }
        },
        onPlayerStats: (payload) => {
            const normalized = payload?.stats ? updateStatsHud(payload.stats) : latestStats;
            handleUpgradeAvailability(payload?.upgradeOptions, normalized);
            handleWeaponChoices(payload?.weaponChoices);
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
    hideWeaponChoices();
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
        moveSpeed: stats?.moveSpeed ?? baselineStats.moveSpeed,
        unspentStatPoints: stats?.unspentStatPoints ?? baselineStats.unspentStatPoints,
        isEthereal: Boolean(stats?.isEthereal ?? baselineStats.isEthereal)
    };

    const level = Math.round(normalized.level);
    const attack = Math.round(normalized.attack);
    const currentHealth = Math.round(normalized.currentHealth);
    const maxHealth = Math.round(normalized.maxHealth);
    const attackSpeed = typeof normalized.attackSpeed === 'number' ? normalized.attackSpeed : baselineStats.attackSpeed;
    const moveSpeed = typeof normalized.moveSpeed === 'number' ? normalized.moveSpeed : baselineStats.moveSpeed;
    const experience = Math.max(0, Math.round(normalized.experience));
    const experienceToNext = Math.max(0, Math.round(normalized.experienceToNext));

    hudElements.level.textContent = level;
    hudElements.attack.textContent = attack;
    hudElements.health.textContent = `${currentHealth} / ${maxHealth}`;

    if (hudElements.attackSpeed) {
        hudElements.attackSpeed.textContent = `${attackSpeed.toFixed(2)}x`;
    }
    if (hudElements.moveSpeed) {
        hudElements.moveSpeed.textContent = `${moveSpeed.toFixed(1)} u/s`;
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
        moveSpeed,
        unspentStatPoints: Math.max(0, Math.round(Number(normalized.unspentStatPoints ?? 0))),
        isEthereal: normalized.isEthereal
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
    const sortedAbilities = [...abilities].sort((a, b) => {
        const slotA = typeof a.weaponSlot === 'number' ? a.weaponSlot : (typeof a.slot === 'number' ? a.slot : 99);
        const slotB = typeof b.weaponSlot === 'number' ? b.weaponSlot : (typeof b.slot === 'number' ? b.slot : 99);
        if (slotA !== slotB) {
            return slotA - slotB;
        }
        const priorityA = typeof a.priority === 'number' ? a.priority : 1;
        const priorityB = typeof b.priority === 'number' ? b.priority : 1;
        if (priorityA !== priorityB) {
            return priorityA - priorityB;
        }
        const nameA = a.name ?? '';
        const nameB = b.name ?? '';
        return nameA.localeCompare(nameB);
    });

    player.setAbilitySnapshots(sortedAbilities);

    const container = abilityUi.container;
    if (!container) return;

    const seenIds = new Set();
    sortedAbilities.forEach(ability => {
        const id = ability.abilityId ?? ability.id;
        if (!id) {
            return;
        }
        const defaults = getAbilityDefaults(id) ?? {};
        const autoCast = ability.autoCast ?? defaults.autoCast ?? true;
        const priority = typeof ability.priority === 'number'
            ? ability.priority
            : (typeof defaults.priority === 'number' ? defaults.priority : 1);
        const weaponSlot = typeof ability.weaponSlot === 'number'
            ? ability.weaponSlot
            : (typeof defaults.weaponSlot === 'number' ? defaults.weaponSlot : null);
        let slot = abilityUi.slots.get(id);
        if (!slot) {
            slot = createAbilitySlot();
            abilityUi.slots.set(id, slot);
            container.appendChild(slot.root);
        }
        seenIds.add(id);
        slot.name.textContent = ability.name ?? defaults.name ?? id;
        slot.root.dataset.locked = ability.unlocked ? 'false' : 'true';
        slot.root.dataset.available = ability.available ? 'true' : 'false';
        slot.root.dataset.autocast = autoCast ? 'true' : 'false';
        const slotLabel = typeof weaponSlot === 'number' ? `Slot ${weaponSlot}` : '';
        const keyLabel = slotLabel || ability.key || defaults.key || '';
        slot.root.dataset.keyLabel = keyLabel;
        slot.root.dataset.range = typeof ability.range === 'number' ? ability.range : (defaults.range ?? '');
        slot.root.dataset.priority = priority;
        slot.root.dataset.weaponSlot = weaponSlot ?? '';
        slot.root.style.order = typeof weaponSlot === 'number' ? weaponSlot : 99;
    });

    Array.from(abilityUi.slots.entries()).forEach(([id, slot]) => {
        if (!seenIds.has(id)) {
            if (slot?.root?.parentElement) {
                slot.root.parentElement.removeChild(slot.root);
            }
            abilityUi.slots.delete(id);
        }
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

function pickRandomStatOptions(count = 3) {
    const working = Array.from(STAT_UPGRADE_POOL);
    const picks = [];
    while (working.length > 0 && picks.length < count) {
        const index = Math.floor(Math.random() * working.length);
        picks.push(working.splice(index, 1)[0]);
    }
    return picks;
}

function showUpgradeOptions(options, remainingPoints) {
    if (!upgradeUi?.overlay || !upgradeUi?.options || !upgradeUi?.remaining) {
        return;
    }

    const list = Array.isArray(options) && options.length > 0
        ? options.slice(0, 3)
        : pickRandomStatOptions(3);
    upgradeSelectionPending = false;
    upgradeUi.overlay.dataset.visible = 'true';
    upgradeUi.overlay.dataset.processing = 'false';
    upgradeUi.options.innerHTML = '';

    player?.setMenuState?.('upgrade', true);

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
    player?.setMenuState?.('upgrade', false);
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

function handleWeaponChoices(options) {
    if (Array.isArray(options) && options.length > 0) {
        showWeaponChoices(options);
    } else {
        hideWeaponChoices();
    }
}

function showWeaponChoices(options) {
    if (!weaponUi?.overlay || !weaponUi?.options) {
        return;
    }

    const list = Array.isArray(options) ? options.filter(opt => opt && (opt.id || opt.abilityId)) : [];
    if (list.length === 0) {
        hideWeaponChoices();
        return;
    }

    weaponSelectionPending = false;
    weaponUi.overlay.dataset.visible = 'true';
    weaponUi.overlay.dataset.processing = 'false';
    weaponUi.options.innerHTML = '';

    player?.setMenuState?.('weapon', true);

    list.slice(0, 3).forEach(option => {
        const id = option?.id ?? option?.abilityId;
        if (!id) {
            return;
        }
        const name = option.name ?? id;
        const description = option.description ?? '';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'weapon-option';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'weapon-name';
        nameSpan.textContent = name;
        button.appendChild(nameSpan);
        if (description) {
            const descSpan = document.createElement('span');
            descSpan.className = 'weapon-desc';
            descSpan.textContent = description;
            button.appendChild(descSpan);
        }
        button.addEventListener('click', () => chooseWeapon(id, name));
        weaponUi.options.appendChild(button);
    });

    if (weaponUi.title) {
        weaponUi.title.textContent = 'Choose Weapon';
    }
    if (weaponUi.hint) {
        weaponUi.hint.textContent = 'Select a weapon to equip';
    }
}

function hideWeaponChoices() {
    if (!weaponUi?.overlay) {
        return;
    }
    weaponSelectionPending = false;
    weaponUi.overlay.dataset.visible = 'false';
    weaponUi.overlay.dataset.processing = 'false';
    if (weaponUi.options) {
        weaponUi.options.innerHTML = '';
    }
    if (weaponUi.hint) {
        weaponUi.hint.textContent = '';
    }
    player?.setMenuState?.('weapon', false);
}

function chooseWeapon(abilityId, label) {
    if (!abilityId || weaponSelectionPending) {
        return;
    }
    if (!network || typeof network.sendWeaponChoice !== 'function') {
        log('Unable to send weapon selection right now.');
        return;
    }

    weaponSelectionPending = true;
    if (weaponUi?.overlay) {
        weaponUi.overlay.dataset.processing = 'true';
    }
    if (weaponUi?.hint) {
        weaponUi.hint.textContent = 'Equipping weapon…';
    }
    if (weaponUi?.options) {
        weaponUi.options.querySelectorAll('button').forEach(button => {
            button.disabled = true;
        });
    }

    log(`Equipping ${label ?? abilityId}.`);
    network.sendWeaponChoice(abilityId);
}

function createAbilitySlot() {
    const root = document.createElement('div');
    root.className = 'ability-slot';
    root.style.order = 99;
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
        const slotIndex = slot.root.dataset.weaponSlot;
        const slotLabel = slotIndex ? `Slot ${slotIndex}` : '';
        const keyLabel = slot.root.dataset.keyLabel || slotLabel;
        if (state.autoCast) {
            slot.key.textContent = keyLabel ? `AUTO · ${keyLabel}` : 'AUTO';
        } else {
            slot.key.textContent = keyLabel;
        }
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

    const formatAngle = (value) => Number.isFinite(value) ? `${value.toFixed(1)}°` : '—';
    const formatRadians = (value) => Number.isFinite(value) ? `${value.toFixed(3)} rad` : '—';
    const formatVector3 = (x, y, z) => (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))
        ? `${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}`
        : '—';
    const formatVector2 = (x, z) => (Number.isFinite(x) && Number.isFinite(z))
        ? `${x.toFixed(2)}, ${z.toFixed(2)}`
        : '—';
    const formatDistance = (value) => Number.isFinite(value) ? `${value.toFixed(2)} u` : '—';
    const formatSpeed = (value) => Number.isFinite(value) ? `${value.toFixed(2)} u/s` : '—';
    const formatSigned = (value) => Number.isFinite(value)
        ? (value >= 0 ? `+${value.toFixed(2)}` : value.toFixed(2))
        : '—';
    const formatBool = (value) => value === true ? 'Yes' : value === false ? 'No' : '—';

    if (debugElements.heading) debugElements.heading.textContent = formatAngle(info?.headingDegrees);
    if (debugElements.headingRad) debugElements.headingRad.textContent = formatRadians(info?.headingRadians);
    if (debugElements.cameraYaw) debugElements.cameraYaw.textContent = formatAngle(info?.cameraYawDegrees);
    if (debugElements.cameraYawRad) debugElements.cameraYawRad.textContent = formatRadians(info?.cameraYawRadians);
    if (debugElements.position) debugElements.position.textContent = info ? formatVector3(info.positionX, info.positionY, info.positionZ) : '—';
    if (debugElements.velocity) debugElements.velocity.textContent = info ? formatVector2(info.velocityX, info.velocityZ) : '—';
    if (debugElements.speed) debugElements.speed.textContent = formatSpeed(info?.speed);
    if (debugElements.verticalVelocity) debugElements.verticalVelocity.textContent = formatSpeed(info?.verticalVelocity);
    if (debugElements.groundHeight) debugElements.groundHeight.textContent = formatDistance(info?.groundHeight);
    if (debugElements.contactHeight) debugElements.contactHeight.textContent = formatDistance(info?.contactHeight);
    if (debugElements.groundDistance) debugElements.groundDistance.textContent = formatDistance(info?.groundDistance);
    if (debugElements.stepHeight) debugElements.stepHeight.textContent = formatDistance(info?.maxStepHeight);
    if (debugElements.grounded) debugElements.grounded.textContent = formatBool(info?.isGrounded);
    if (debugElements.ethereal) debugElements.ethereal.textContent = formatBool(info?.isEthereal);
    if (debugElements.inputForward) debugElements.inputForward.textContent = formatSigned(info?.inputForward);
    if (debugElements.inputStrafe) debugElements.inputStrafe.textContent = formatSigned(info?.inputStrafe);
    if (debugElements.inputTurn) debugElements.inputTurn.textContent = formatSigned(info?.inputTurn);

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
