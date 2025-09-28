// abilities.js

export const ABILITY_DEFAULTS = {
    kineticEdge: {
        name: 'Kinetic Edge',
        key: 'Slot 1',
        weaponSlot: 1,
        range: 4,
        cooldown: 1.4,
        unlocked: true,
        resetOnLevelUp: false,
        autoCast: true,
        scalesWithAttackSpeed: true,
        priority: 1
    },
    aetherCyclone: {
        name: 'Aether Cyclone',
        key: 'Slot 2',
        weaponSlot: 2,
        range: 5.5,
        cooldown: 7,
        unlocked: false,
        resetOnLevelUp: true,
        autoCast: true,
        priority: 0.7
    },
    singularityPiercer: {
        name: 'Singularity Piercer',
        key: 'Slot 3',
        weaponSlot: 3,
        range: 20,
        cooldown: 9.5,
        unlocked: false,
        resetOnLevelUp: true,
        autoCast: true,
        priority: 0.5
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
        priority: typeof def.priority === 'number' ? def.priority : 1,
        weaponSlot: typeof def.weaponSlot === 'number' ? def.weaponSlot : 0
    }));
}

export function getAbilityDefaults(abilityId) {
    return ABILITY_DEFAULTS[abilityId] ?? null;
}
