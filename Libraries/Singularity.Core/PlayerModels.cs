using System.Collections.Concurrent;

namespace Singularity.Core;

public sealed class PlayerState
{
    public PlayerState(string id, string displayName, double x, double y, double z)
    {
        Id = id;
        DisplayName = displayName;
        X = x;
        Y = y;
        Z = z;
    }

    public string Id { get; }
    public string DisplayName { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
    public double Heading { get; set; }
    public double VelocityX { get; set; }
    public double VelocityZ { get; set; }
    public DateTime LastUpdate { get; set; } = DateTime.UtcNow;
    public PlayerStats Stats { get; } = new();
    public ConcurrentDictionary<string, PlayerAbilityState> Abilities { get; } = new();
}

public sealed class PlayerSnapshot
{
    public string PlayerId { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
    public double Heading { get; set; }
    public double VelocityX { get; set; }
    public double VelocityZ { get; set; }
    public long LastServerUpdate { get; set; }
}

public sealed class PlayerStats
{
    public int Level { get; set; } = 1;
    public int Experience { get; set; }
    public int ExperienceToNext { get; set; } = 100;
    public int Attack { get; set; } = 10;
    public int MaxHealth { get; set; } = 100;
    public int CurrentHealth { get; set; } = 100;
    public double AttackSpeed { get; set; } = 1.0;
    public int UnspentStatPoints { get; set; }
}

public sealed class PlayerStatsDto
{
    public int Level { get; set; }
    public int Experience { get; set; }
    public int ExperienceToNext { get; set; }
    public int Attack { get; set; }
    public int MaxHealth { get; set; }
    public int CurrentHealth { get; set; }
    public double AttackSpeed { get; set; }
    public int UnspentStatPoints { get; set; }
}

public sealed class PlayerAbilityState
{
    public string AbilityId { get; set; } = string.Empty;
    public DateTime CooldownUntil { get; set; } = DateTime.UtcNow;
    public bool Unlocked { get; set; }
}

public sealed class AbilityDto
{
    public string AbilityId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Key { get; set; } = string.Empty;
    public double CooldownSeconds { get; set; }
    public bool Unlocked { get; set; }
    public bool Available { get; set; }
    public bool ResetOnLevelUp { get; set; }
    public double Range { get; set; }
    public bool AutoCast { get; set; }
    public double Priority { get; set; }
    public int WeaponSlot { get; set; }
}

public sealed class AbilityDefinition
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string Key { get; init; } = string.Empty;
    public double CooldownSeconds { get; init; }
    public double DamageMultiplier { get; init; }
    public int UnlockLevel { get; init; }
    public bool ResetOnLevelUp { get; init; }
    public bool ScalesWithAttackSpeed { get; init; }
    public AttackDescriptor? Attack { get; init; }
    public bool AutoCast { get; init; } = true;
    public double Priority { get; init; } = 1.0;
    public int WeaponSlot { get; init; }
}

public sealed class PlayerStatUpgradeOption
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
}
