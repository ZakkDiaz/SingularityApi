// abilities.js

export const ABILITY_DEFAULTS = {
    autoAttack: {
        name: 'Auto Attack',
        key: '1',
        range: 7,
        cooldown: 1.6,
        unlocked: true,
        resetOnLevelUp: false
    },
    instantStrike: {
        name: 'Skyburst Strike',
        key: '2',
        range: 9,
        cooldown: 10,
        unlocked: false,
        resetOnLevelUp: true
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
        resetOnLevelUp: Boolean(def.resetOnLevelUp)
    }));
}

export function getAbilityDefaults(abilityId) {
    return ABILITY_DEFAULTS[abilityId] ?? null;
}
