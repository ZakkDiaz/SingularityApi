// abilities.js

export const BASELINE_ABILITIES = [
    {
        id: 'autoAttack',
        name: 'Auto Attack',
        key: '1',
        cooldown: 1.6,
        cooldownRemaining: 0,
        unlocked: true
    },
    {
        id: 'instantStrike',
        name: 'Skyburst Strike',
        key: '2',
        cooldown: 10,
        cooldownRemaining: 10,
        unlocked: false
    }
];

export function createBaselineAbilitySnapshots() {
    return BASELINE_ABILITIES.map(ability => ({ ...ability }));
}
