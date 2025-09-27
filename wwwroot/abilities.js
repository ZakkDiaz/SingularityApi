// abilities.js

export const ABILITY_DEFAULTS = {
    autoAttack: {
        name: 'Auto Attack',
        key: '1',
        range: 4,
        cooldown: 1.6,
        unlocked: true,
        resetOnLevelUp: false,
        autoCast: true,
        scalesWithAttackSpeed: true,
        priority: 1
    },
    sweepingStrike: {
        name: 'Sweeping Strike',
        key: '2',
        range: 5,
        cooldown: 7.5,
        unlocked: false,
        resetOnLevelUp: true,
        autoCast: true,
        priority: 0.5
    },
    fireball: {
        name: 'Fireball',
        key: '3',
        range: 18,
        cooldown: 9,
        unlocked: false,
        resetOnLevelUp: true,
        autoCast: true,
        priority: 0.75
    }
};

export function createBaselineAbilitySnapshots() {
    return Object.entries(ABILITY_DEFAULTS).map(([abilityId, def]) => ({
        abilityId,
        name: def.name,
        key: def.key,
        cooldownSeconds: 0,
        unlocked: Boolean(def.unlocked),
        available: Boolean(def.unlocked),
        resetOnLevelUp: Boolean(def.resetOnLevelUp),
        autoCast: def.autoCast !== false,
        range: def.range,
        priority: typeof def.priority === 'number' ? def.priority : 1
    }));
}

export function getAbilityDefaults(abilityId) {
    return ABILITY_DEFAULTS[abilityId] ?? null;
}
