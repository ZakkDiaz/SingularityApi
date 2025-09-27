namespace Singularity.Core;

public sealed class Vertex
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
}

public sealed class ChunkData
{
    public ChunkData(
        IReadOnlyList<Vertex> vertices,
        IReadOnlyList<EnvironmentBlueprint> environmentBlueprints,
        IReadOnlyList<MobBlueprint> mobBlueprints)
    {
        Vertices = vertices;
        EnvironmentBlueprints = environmentBlueprints;
        MobBlueprints = mobBlueprints;
    }

    public IReadOnlyList<Vertex> Vertices { get; }
    public IReadOnlyList<EnvironmentBlueprint> EnvironmentBlueprints { get; }
    public IReadOnlyList<MobBlueprint> MobBlueprints { get; }
}

public sealed class MobBlueprint
{
    public string Id { get; set; } = string.Empty;
    public int ChunkX { get; set; }
    public int ChunkZ { get; set; }
    public string Type { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string ArchetypeId { get; set; } = string.Empty;
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
    public MobStatBlock Stats { get; set; } = new();
}

public sealed class MobSnapshotDto
{
    public string Id { get; set; } = string.Empty;
    public string Type { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
    public double Heading { get; set; }
    public bool IsAlive { get; set; }
    public double HealthFraction { get; set; }
    public string? TargetPlayerId { get; set; }
}

public sealed class MobStatBlock
{
    public int Strength { get; set; }
    public int Agility { get; set; }
    public int Intelligence { get; set; }
    public double MaxHealth { get; set; }
    public double AttackDamage { get; set; }
    public double AttackInterval { get; set; }
    public double MoveSpeed { get; set; }
    public double AggroRange { get; set; }
    public double AttackRange { get; set; }
}

public sealed class EnvironmentBlueprint
{
    public string Id { get; set; } = string.Empty;
    public int ChunkX { get; set; }
    public int ChunkZ { get; set; }
    public string Type { get; set; } = string.Empty;
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
    public double Rotation { get; set; }
}

public sealed class EnvironmentObjectDto
{
    public string Id { get; set; } = string.Empty;
    public int ChunkX { get; set; }
    public int ChunkZ { get; set; }
    public string Type { get; set; } = string.Empty;
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
    public double Rotation { get; set; }
    public EnvironmentStateDto State { get; set; } = new();
}

public sealed class EnvironmentStateDto
{
    public bool IsActive { get; set; }
    public double CooldownRemaining { get; set; }
    public double HealthFraction { get; set; }
}
