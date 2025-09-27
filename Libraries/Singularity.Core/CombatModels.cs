using System.Collections.Generic;

namespace Singularity.Core;

public enum AttackBehavior
{
    Melee,
    Sweep,
    Projectile
}

public enum AttackTargetType
{
    None,
    Mob,
    Environment
}

public sealed class AttackDescriptor
{
    public AttackBehavior Behavior { get; init; }
    public double Range { get; init; }
    public double Radius { get; init; }
    public double Speed { get; init; }
    public double LifetimeSeconds { get; init; }
    public double WindupSeconds { get; init; }
    public bool HitsMultipleTargets { get; init; }
    public bool RequiresTarget { get; init; } = true;
    public bool CanHitMobs { get; init; } = true;
    public bool CanHitEnvironment { get; init; }
}

public sealed class AttackInstance
{
    public AttackInstance(
        string id,
        AttackDescriptor descriptor,
        string abilityId,
        string ownerPlayerId,
        string? targetId,
        double damage)
    {
        Id = id;
        Descriptor = descriptor;
        AbilityId = abilityId;
        OwnerPlayerId = ownerPlayerId;
        TargetId = targetId;
        Damage = damage;
    }

    public string Id { get; }
    public AttackDescriptor Descriptor { get; }
    public string AbilityId { get; }
    public string OwnerPlayerId { get; }
    public string? TargetId { get; }
    public AttackTargetType TargetType { get; set; }
    public double Damage { get; }
    public double OriginX { get; set; }
    public double OriginY { get; set; }
    public double OriginZ { get; set; }
    public double CurrentX { get; set; }
    public double CurrentZ { get; set; }
    public double DirectionX { get; set; }
    public double DirectionZ { get; set; }
    public double DistanceTravelled { get; set; }
    public double LifetimeSeconds { get; set; }
    public double AgeSeconds { get; set; }
    public bool Completed { get; set; }
    public bool HasTriggeredDamage { get; set; }
    public HashSet<string> HitTargets { get; } = new();
}

public sealed class AttackSpawnDto
{
    public string AttackId { get; set; } = string.Empty;
    public string AbilityId { get; set; } = string.Empty;
    public string OwnerId { get; set; } = string.Empty;
    public string Behavior { get; set; } = string.Empty;
    public string? TargetId { get; set; }
    public double OriginX { get; set; }
    public double OriginY { get; set; }
    public double OriginZ { get; set; }
    public double DirectionX { get; set; }
    public double DirectionZ { get; set; }
    public double Radius { get; set; }
    public double Range { get; set; }
    public double Speed { get; set; }
    public double WindupSeconds { get; set; }
    public double LifetimeSeconds { get; set; }
}

public sealed class AttackSnapshotDto
{
    public string AttackId { get; set; } = string.Empty;
    public string AbilityId { get; set; } = string.Empty;
    public string Behavior { get; set; } = string.Empty;
    public double X { get; set; }
    public double Z { get; set; }
    public double Radius { get; set; }
    public double Progress { get; set; }
}
