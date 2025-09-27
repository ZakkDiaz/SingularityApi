namespace Singularity.Core;

public sealed class GameWorldOptions
{
    public int ChunkSize { get; init; } = 16;
    public int WorldSeed { get; init; } = 1337;
    public double MaxMoveDistanceSquared { get; init; } = 36.0;
    public int TerrainOctaves { get; init; } = 5;
    public double TerrainPersistence { get; init; } = 0.5;
    public double TerrainBaseFrequency { get; init; } = 0.01;
    public double TerrainBaseAmplitude { get; init; } = 8.0;
    public double DayLengthSeconds { get; init; } = 480.0;
    public double SentinelBaseHealth { get; init; } = 40.0;
    public double SentinelRespawnSeconds { get; init; } = 18.0;
    public int SentinelXpReward { get; init; } = 35;
    public double MobBaseHealth { get; init; } = 60.0;
    public double MobRespawnSeconds { get; init; } = 20.0;
    public int MobXpReward { get; init; } = 55;
    public double MobAttackDamage { get; init; } = 14.0;
    public double MobAttackCooldown { get; init; } = 2.2;
    public double MobMoveSpeed { get; init; } = 4.6;
    public double MobAggroRange { get; init; } = 24.0;
    public double MobAttackRange { get; init; } = 2.4;
}
