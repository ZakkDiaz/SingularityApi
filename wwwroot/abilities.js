// abilities.js

export const ABILITY_DEFAULTS = {
    swordSweep: {
        name: 'Sword Sweep',
        range: 4.2,
        cooldown: 1.5,
        autoCast: true,
        scalesWithAttackSpeed: true,
        priority: 1.0
    },
    arrowStrike: {
        name: 'Arrow Strike',
        range: 22,
        cooldown: 1.8,
        autoCast: true,
        scalesWithAttackSpeed: true,
        priority: 0.9
    },
    fireball: {
        name: 'Fireball',
        range: 18,
        cooldown: 3.8,
        autoCast: true,
        priority: 1.4
    },
    shadowDaggers: {
        name: 'Shadow Daggers',
        range: 2.6,
        cooldown: 0.7,
        autoCast: true,
        scalesWithAttackSpeed: true,
        priority: 0.6
    },
    stormChaser: {
        name: 'Storm Chaser',
        range: 16,
        cooldown: 2.6,
        autoCast: true,
        priority: 1.2
    },
    frostNova: {
        name: 'Frost Nova',
        range: 5.5,
        cooldown: 6.0,
        autoCast: true,
        priority: 1.6
    },
    earthshatter: {
        name: 'Earthshatter',
        range: 6.5,
        cooldown: 7.5,
        autoCast: true,
        priority: 1.8
    },
    windBlade: {
        name: 'Wind Blade',
        range: 24,
        cooldown: 2.2,
        autoCast: true,
        scalesWithAttackSpeed: true,
        priority: 1.1
    },
    arcaneOrbit: {
        name: 'Arcane Orbit',
        range: 4.5,
        cooldown: 5.0,
        autoCast: true,
        priority: 1.5
    },
    voidLance: {
        name: 'Void Lance',
        range: 26,
        cooldown: 7.0,
        autoCast: true,
        priority: 2.0
    }
};

export function createBaselineAbilitySnapshots() {
    const sword = ABILITY_DEFAULTS.swordSweep;
    return [
        {
            abilityId: 'swordSweep',
            name: sword.name,
            key: 'Slot 1',
            cooldownSeconds: 0,
            unlocked: true,
            available: true,
            resetOnLevelUp: false,
            autoCast: sword.autoCast !== false,
            range: sword.range,
            priority: typeof sword.priority === 'number' ? sword.priority : 1,
            weaponSlot: 1
        }
    ];
}

export function getAbilityDefaults(abilityId) {
    return ABILITY_DEFAULTS[abilityId] ?? null;
}
