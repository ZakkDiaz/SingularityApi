using System;
using System.Collections.Concurrent;

namespace Singularity.Core;

public enum PlayerAttribute
{
    Strength,
    Agility,
    Intelligence
}

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
    public string? ClassId { get; set; }
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
    public string? ClassId { get; set; }
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
    public int Strength { get; set; } = 8;
    public int Agility { get; set; } = 8;
    public int Intelligence { get; set; } = 8;
    public int Attack { get; set; }
    public int MaxHealth { get; set; }
    public int CurrentHealth { get; set; }
    public double AttackSpeed { get; set; }
    public int UnspentStatPoints { get; set; }

    public PlayerStats()
    {
        RecalculateDerivedStats();
        CurrentHealth = MaxHealth;
    }

    public void ApplyClass(PlayerClassDefinition classDefinition)
    {
        Strength = classDefinition.StartingStrength;
        Agility = classDefinition.StartingAgility;
        Intelligence = classDefinition.StartingIntelligence;
        RecalculateDerivedStats();
        CurrentHealth = MaxHealth;
    }

    public void RecalculateDerivedStats()
    {
        Attack = Math.Max(4, 6 + Strength * 3 + (int)Math.Round(Agility * 1.5));
        MaxHealth = Math.Max(60, 70 + Strength * 12 + (int)Math.Round(Intelligence * 4.5));
        var attackSpeed = 0.8 + Agility * 0.05 + Intelligence * 0.02;
        AttackSpeed = Math.Round(Math.Clamp(attackSpeed, 0.6, 3.5), 2, MidpointRounding.AwayFromZero);
        CurrentHealth = Math.Min(CurrentHealth, MaxHealth);
    }

    public double GetAttribute(PlayerAttribute attribute) => attribute switch
    {
        PlayerAttribute.Strength => Strength,
        PlayerAttribute.Agility => Agility,
        PlayerAttribute.Intelligence => Intelligence,
        _ => 0
    };

    public double GetCombatRating()
    {
        var rating = Strength * 1.8 + Agility * 1.6 + Intelligence * 1.4 + Attack * 0.75 + MaxHealth * 0.05 + AttackSpeed * 12.0;
        return Math.Round(rating, 2, MidpointRounding.AwayFromZero);
    }
}

public sealed class PlayerStatsDto
{
    public int Level { get; set; }
    public int Experience { get; set; }
    public int ExperienceToNext { get; set; }
    public string? ClassId { get; set; }
    public int Strength { get; set; }
    public int Agility { get; set; }
    public int Intelligence { get; set; }
    public int Attack { get; set; }
    public int MaxHealth { get; set; }
    public int CurrentHealth { get; set; }
    public double AttackSpeed { get; set; }
    public int UnspentStatPoints { get; set; }
    public double CombatRating { get; set; }
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
    public string? RequiredClassId { get; set; }
    public string? ScalingStat { get; set; }
}

public sealed class AbilityDefinition
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string Key { get; init; } = string.Empty;
    public double CooldownSeconds { get; init; }
    public double DamageMultiplier { get; init; }
    public double FlatBonusDamage { get; init; }
    public double ScalingCoefficient { get; init; }
    public PlayerAttribute? ScalingStat { get; init; }
    public int UnlockLevel { get; init; }
    public bool ResetOnLevelUp { get; init; }
    public bool ScalesWithAttackSpeed { get; init; }
    public string? RequiredClassId { get; init; }
    public AttackDescriptor? Attack { get; init; }
    public bool AutoCast { get; init; } = true;
    public double Priority { get; init; } = 1.0;
}

public sealed class PlayerStatUpgradeOption
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
}

public sealed class PlayerClassDefinition
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string Description { get; init; } = string.Empty;
    public PlayerAttribute PrimaryAttribute { get; init; }
    public int StartingStrength { get; init; }
    public int StartingAgility { get; init; }
    public int StartingIntelligence { get; init; }
    public string StartingAbilityId { get; init; } = string.Empty;
}

public sealed class PlayerClassSummaryDto
{
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string PrimaryAttribute { get; set; } = string.Empty;
    public int StartingStrength { get; set; }
    public int StartingAgility { get; set; }
    public int StartingIntelligence { get; set; }
    public string StartingAbilityId { get; set; } = string.Empty;
}
