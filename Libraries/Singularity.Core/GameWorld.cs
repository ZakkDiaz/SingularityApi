using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using Singularity.Core.Noise;

namespace Singularity.Core;

public sealed class GameWorld : IDisposable
{
    private readonly GameWorldOptions _options;
    private readonly ConcurrentDictionary<(int, int), ChunkData> _chunkCache = new();
    private readonly ConcurrentDictionary<string, PlayerState> _players = new();
    private readonly EnvironmentManager _environmentManager;
    private readonly MobManager _mobManager;
    private readonly AbilityDefinition[] _abilityDefinitions;
    private readonly PlayerClassDefinition[] _classDefinitions;
    private readonly MobArchetype[] _mobArchetypes;
    private readonly object _attackLock = new();
    private readonly Dictionary<string, AttackInstance> _activeAttacks = new();
    private static readonly PlayerStatUpgradeOption[] StatUpgradeOptions =
    {
        new()
        {
            Id = "strength",
            Name = "Might",
            Description = "+2 Strength (attack & health)"
        },
        new()
        {
            Id = "agility",
            Name = "Swiftness",
            Description = "+2 Agility (speed & evasion)"
        },
        new()
        {
            Id = "intelligence",
            Name = "Wisdom",
            Description = "+2 Intelligence (focus & sustain)"
        }
    };
    private readonly Timer _worldTimer;
    private DateTime _lastWorldTick = DateTime.UtcNow;
    private double _timeOfDayFraction = 0.25;
    private readonly object _worldClockLock = new();

    public event EventHandler<WorldTickEventArgs>? WorldTicked;

    public GameWorld(GameWorldOptions? options = null)
    {
        _options = options ?? new GameWorldOptions();
        _environmentManager = new EnvironmentManager(_options);
        _mobManager = new MobManager(_options);

        _classDefinitions = new[]
        {
            new PlayerClassDefinition
            {
                Id = "warrior",
                Name = "Vanguard",
                Description = "Strength-driven fighters who dominate the frontline.",
                PrimaryAttribute = PlayerAttribute.Strength,
                StartingStrength = 18,
                StartingAgility = 9,
                StartingIntelligence = 7,
                StartingAbilityId = "crushingBlow"
            },
            new PlayerClassDefinition
            {
                Id = "ranger",
                Name = "Storm Ranger",
                Description = "Agile skirmishers that overwhelm foes with relentless volleys.",
                PrimaryAttribute = PlayerAttribute.Agility,
                StartingStrength = 12,
                StartingAgility = 18,
                StartingIntelligence = 8,
                StartingAbilityId = "rapidVolley"
            },
            new PlayerClassDefinition
            {
                Id = "arcanist",
                Name = "Arcanist",
                Description = "Intelligence-focused casters who channel raw energy into devastating bursts.",
                PrimaryAttribute = PlayerAttribute.Intelligence,
                StartingStrength = 9,
                StartingAgility = 11,
                StartingIntelligence = 20,
                StartingAbilityId = "arcaneBurst"
            }
        };

        _abilityDefinitions = new[]
        {
            new AbilityDefinition
            {
                Id = "autoAttack",
                Name = "Auto Attack",
                Key = "1",
                CooldownSeconds = 1.6,
                DamageMultiplier = 1.0,
                FlatBonusDamage = 2,
                ScalingCoefficient = 0.04,
                ScalingStat = PlayerAttribute.Strength,
                UnlockLevel = 1,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = true,
                AutoCast = true,
                Priority = 1.0,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Melee,
                    Range = 3.6,
                    Radius = 2.4,
                    Speed = 0,
                    LifetimeSeconds = 0.55,
                    WindupSeconds = 0.15,
                    HitsMultipleTargets = false,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "crushingBlow",
                Name = "Crushing Blow",
                Key = "2",
                CooldownSeconds = 8.0,
                DamageMultiplier = 1.2,
                FlatBonusDamage = 10,
                ScalingCoefficient = 0.08,
                ScalingStat = PlayerAttribute.Strength,
                UnlockLevel = 1,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = false,
                RequiredClassId = "warrior",
                AutoCast = false,
                Priority = 0.85,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Melee,
                    Range = 4.2,
                    Radius = 2.2,
                    Speed = 0,
                    LifetimeSeconds = 0.7,
                    WindupSeconds = 0.3,
                    HitsMultipleTargets = false,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "rapidVolley",
                Name = "Rapid Volley",
                Key = "2",
                CooldownSeconds = 7.0,
                DamageMultiplier = 1.05,
                FlatBonusDamage = 6,
                ScalingCoefficient = 0.07,
                ScalingStat = PlayerAttribute.Agility,
                UnlockLevel = 1,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = true,
                RequiredClassId = "ranger",
                AutoCast = false,
                Priority = 0.9,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 22,
                    Radius = 1.4,
                    Speed = 22,
                    LifetimeSeconds = 1.6,
                    WindupSeconds = 0.18,
                    HitsMultipleTargets = true,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "arcaneBurst",
                Name = "Arcane Burst",
                Key = "2",
                CooldownSeconds = 9.0,
                DamageMultiplier = 1.1,
                FlatBonusDamage = 14,
                ScalingCoefficient = 0.09,
                ScalingStat = PlayerAttribute.Intelligence,
                UnlockLevel = 1,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = false,
                RequiredClassId = "arcanist",
                AutoCast = false,
                Priority = 0.95,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 24,
                    Radius = 2.2,
                    Speed = 18,
                    LifetimeSeconds = 2.2,
                    WindupSeconds = 0.22,
                    HitsMultipleTargets = true,
                    RequiresTarget = false,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "sweepingStrike",
                Name = "Sweeping Strike",
                Key = "3",
                CooldownSeconds = 7.5,
                DamageMultiplier = 1.4,
                FlatBonusDamage = 6,
                ScalingCoefficient = 0.05,
                ScalingStat = PlayerAttribute.Strength,
                UnlockLevel = 3,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 0.55,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Sweep,
                    Range = 5.0,
                    Radius = 5.0,
                    Speed = 0,
                    LifetimeSeconds = 0.9,
                    WindupSeconds = 0.35,
                    HitsMultipleTargets = true,
                    RequiresTarget = false,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "fireball",
                Name = "Fireball",
                Key = "4",
                CooldownSeconds = 9.0,
                DamageMultiplier = 1.5,
                FlatBonusDamage = 12,
                ScalingCoefficient = 0.07,
                ScalingStat = PlayerAttribute.Intelligence,
                UnlockLevel = 5,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 0.75,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 22,
                    Radius = 1.6,
                    Speed = 20,
                    LifetimeSeconds = 2.6,
                    WindupSeconds = 0.2,
                    HitsMultipleTargets = false,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            }
        };

        _mobArchetypes = new[]
        {
            new MobArchetype(
                "brute",
                "runicBrute",
                PlayerAttribute.Strength,
                new StatRange(14, 24),
                new StatRange(6, 12),
                new StatRange(4, 10),
                baseHealth: 180,
                baseDamage: 16,
                baseInterval: 2.6,
                moveSpeed: 3.0,
                aggroRange: 11.5,
                attackRange: 2.6,
                new[] { "Runic Hunter", "Prism Mauler", "Stonecrusher" }),
            new MobArchetype(
                "skirmisher",
                "stormSkirmisher",
                PlayerAttribute.Agility,
                new StatRange(10, 16),
                new StatRange(16, 24),
                new StatRange(6, 12),
                baseHealth: 145,
                baseDamage: 13,
                baseInterval: 1.9,
                moveSpeed: 3.8,
                aggroRange: 12.5,
                attackRange: 3.1,
                new[] { "Storm Dancer", "Gale Stalker", "Windblade" }),
            new MobArchetype(
                "channeler",
                "arcanumChanneler",
                PlayerAttribute.Intelligence,
                new StatRange(8, 14),
                new StatRange(10, 16),
                new StatRange(18, 26),
                baseHealth: 150,
                baseDamage: 15,
                baseInterval: 2.2,
                moveSpeed: 3.2,
                aggroRange: 13.5,
                attackRange: 3.4,
                new[] { "Runic Channeler", "Prism Seer", "Aether Sentry" })
        };

        _worldTimer = new Timer(WorldTick, null, TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(100));
    }

    public IReadOnlyDictionary<string, PlayerState> Players => _players;

    public IReadOnlyList<AbilityDefinition> AbilityDefinitions => _abilityDefinitions;

    public IReadOnlyList<PlayerClassDefinition> ClassDefinitions => _classDefinitions;

    public IReadOnlyList<PlayerStatUpgradeOption> StatUpgradeDefinitions => StatUpgradeOptions;

    public GameWorldOptions Options => _options;

    public PlayerState AddPlayer(string connectionId)
    {
        var spawnX = 0.0;
        var spawnZ = 0.0;
        var groundY = SampleTerrainHeight(spawnX, spawnZ);
        var playerState = new PlayerState(connectionId, $"Explorer-{connectionId[..Math.Min(8, connectionId.Length)]}", spawnX, groundY + 2.0, spawnZ)
        {
            Heading = 0,
            VelocityX = 0,
            VelocityZ = 0,
            LastUpdate = DateTime.UtcNow
        };

        playerState.ClassId = null;
        playerState.Stats.RecalculateDerivedStats();
        playerState.Stats.CurrentHealth = playerState.Stats.MaxHealth;

        _players[connectionId] = playerState;
        return playerState;
    }

    public bool RemovePlayer(string playerId) => _players.TryRemove(playerId, out _);

    public bool TryGetPlayer(string playerId, out PlayerState? state) => _players.TryGetValue(playerId, out state);

    public PlayerSnapshot CreatePlayerSnapshot(PlayerState state)
    {
        lock (state)
        {
            return new PlayerSnapshot
            {
                PlayerId = state.Id,
                DisplayName = state.DisplayName,
                ClassId = state.ClassId,
                X = state.X,
                Y = state.Y,
                Z = state.Z,
                Heading = state.Heading,
                VelocityX = state.VelocityX,
                VelocityZ = state.VelocityZ,
                LastServerUpdate = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            };
        }
    }

    public PlayerStatsDto BuildStatsSnapshot(PlayerState state)
    {
        lock (state)
        {
            return new PlayerStatsDto
            {
                Level = state.Stats.Level,
                Experience = state.Stats.Experience,
                ExperienceToNext = state.Stats.ExperienceToNext,
                ClassId = state.ClassId,
                Strength = state.Stats.Strength,
                Agility = state.Stats.Agility,
                Intelligence = state.Stats.Intelligence,
                Attack = state.Stats.Attack,
                MaxHealth = state.Stats.MaxHealth,
                CurrentHealth = state.Stats.CurrentHealth,
                AttackSpeed = state.Stats.AttackSpeed,
                UnspentStatPoints = state.Stats.UnspentStatPoints,
                CombatRating = state.Stats.GetCombatRating()
            };
        }
    }

    public List<PlayerClassSummaryDto> BuildClassSummaries()
    {
        return _classDefinitions
            .Select(definition => new PlayerClassSummaryDto
            {
                Id = definition.Id,
                Name = definition.Name,
                Description = definition.Description,
                PrimaryAttribute = definition.PrimaryAttribute.ToString().ToLowerInvariant(),
                StartingStrength = definition.StartingStrength,
                StartingAgility = definition.StartingAgility,
                StartingIntelligence = definition.StartingIntelligence,
                StartingAbilityId = definition.StartingAbilityId
            })
            .ToList();
    }

    public List<AbilityDto> BuildAbilitySnapshots(PlayerState state)
    {
        lock (state)
        {
            return BuildAbilitySnapshotsLocked(state, leveledUp: false, DateTime.UtcNow);
        }
    }

    public bool TryUpdatePlayerTransform(
        PlayerState state,
        double x,
        double y,
        double z,
        double heading,
        double velocityX,
        double velocityZ,
        out PlayerSnapshot? snapshot)
    {
        snapshot = null;

        if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(z))
        {
            return false;
        }

        var groundY = SampleTerrainHeight(x, z);
        var maxHeight = groundY + 60.0;
        var minHeight = groundY - 20.0;
        y = Math.Clamp(y, minHeight, maxHeight);

        lock (state)
        {
            var dx = x - state.X;
            var dz = z - state.Z;
            var distanceSq = dx * dx + dz * dz;
            if (distanceSq > _options.MaxMoveDistanceSquared)
            {
                var distance = Math.Sqrt(distanceSq);
                if (distance > 0)
                {
                    var scale = Math.Sqrt(_options.MaxMoveDistanceSquared) / distance;
                    x = state.X + dx * scale;
                    z = state.Z + dz * scale;
                }
                else
                {
                    x = state.X;
                    z = state.Z;
                }
            }

            state.X = x;
            state.Y = y;
            state.Z = z;
            state.Heading = heading;
            state.VelocityX = velocityX;
            state.VelocityZ = velocityZ;
            state.LastUpdate = DateTime.UtcNow;
            snapshot = CreatePlayerSnapshot(state);
        }

        return true;
    }

    public NearbyChunksResult GetNearbyChunks(PlayerState state, int radius)
    {
        int chunkX;
        int chunkZ;

        lock (state)
        {
            chunkX = (int)Math.Floor(state.X / _options.ChunkSize);
            chunkZ = (int)Math.Floor(state.Z / _options.ChunkSize);
        }

        var chunks = new List<ChunkEnvelope>();
        for (var cx = chunkX - radius; cx <= chunkX + radius; cx++)
        {
            for (var cz = chunkZ - radius; cz <= chunkZ + radius; cz++)
            {
                var chunk = GetOrGenerateChunk(cx, cz);
                var environmentObjects = _environmentManager.CreateSnapshotForChunk(chunk);
                var mobs = _mobManager.CreateSnapshotForChunk(chunk);
                chunks.Add(new ChunkEnvelope(cx, cz, chunk.Vertices, environmentObjects, mobs));
            }
        }

        return new NearbyChunksResult(chunkX, chunkZ, _options.ChunkSize, chunks);
    }

    public AbilityExecutionResult ExecuteAbility(string playerId, string abilityId, string? targetId, DateTime now)
    {
        if (!TryGetPlayer(playerId, out var playerState) || playerState is null)
        {
            return new AbilityExecutionResult(abilityId, targetId);
        }

        var abilityDefinition = _abilityDefinitions.FirstOrDefault(a =>
            string.Equals(a.Id, abilityId, StringComparison.OrdinalIgnoreCase));
        if (abilityDefinition == null)
        {
            return new AbilityExecutionResult(abilityId, targetId);
        }

        var player = playerState;
        PlayerStatsDto statsSnapshot;
        List<AbilityDto> abilitySnapshots;
        List<PlayerStatUpgradeOption>? upgradeOptions;
        var shouldStrike = false;
        double damage = 0;
        AttackInstance? createdAttack = null;
        AttackSpawnDto? spawnDto = null;

        lock (player)
        {
            if (!player.Abilities.TryGetValue(abilityDefinition.Id, out var abilityState))
            {
                abilityState = new PlayerAbilityState
                {
                    AbilityId = abilityDefinition.Id,
                    CooldownUntil = now,
                    Unlocked = false
                };
                player.Abilities[abilityDefinition.Id] = abilityState;
            }

            var stats = player.Stats;
            abilityState.Unlocked = IsAbilityAvailableToPlayer(player, abilityDefinition);

            var descriptor = abilityDefinition.Attack;
            var originX = player.X;
            var originY = player.Y;
            var originZ = player.Z;
            var heading = player.Heading;

            if (abilityState.Unlocked && abilityState.CooldownUntil <= now)
            {
                var cooldown = abilityDefinition.CooldownSeconds;
                if (abilityDefinition.ScalesWithAttackSpeed)
                {
                    var speed = Math.Max(0.1, stats.AttackSpeed);
                    cooldown = cooldown / speed;
                }

                cooldown = Math.Max(0.2, cooldown);
                var plannedDamage = CalculateAbilityDamage(stats, abilityDefinition);

                if (descriptor != null)
                {
                    if (TryCreateAttackInstance(
                            abilityDefinition,
                            descriptor,
                            player.Id,
                            originX,
                            originY,
                            originZ,
                            heading,
                            targetId,
                            plannedDamage,
                            out var attack,
                            out var spawn))
                    {
                        abilityState.CooldownUntil = now.AddSeconds(cooldown);
                        damage = plannedDamage;
                        shouldStrike = true;
                        createdAttack = attack;
                        spawnDto = spawn;
                    }
                }
                else if (!string.IsNullOrWhiteSpace(targetId))
                {
                    abilityState.CooldownUntil = now.AddSeconds(cooldown);
                    damage = plannedDamage;
                    shouldStrike = true;
                }
            }

            statsSnapshot = new PlayerStatsDto
            {
                Level = stats.Level,
                Experience = stats.Experience,
                ExperienceToNext = stats.ExperienceToNext,
                ClassId = player.ClassId,
                Strength = stats.Strength,
                Agility = stats.Agility,
                Intelligence = stats.Intelligence,
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                CombatRating = stats.GetCombatRating()
            };

            abilitySnapshots = BuildAbilitySnapshotsLocked(player, leveledUp: false, now);
            upgradeOptions = stats.UnspentStatPoints > 0 ? StatUpgradeOptions.ToList() : null;
        }

        var result = new AbilityExecutionResult(abilityDefinition.Id, targetId);
        result.PlayerUpdates.Add(new PlayerStatsUpdate(player, statsSnapshot, 0, false, null, abilitySnapshots, upgradeOptions));

        if (!shouldStrike)
        {
            return result;
        }

        result.AbilityTriggered = true;

        if (createdAttack != null && spawnDto != null)
        {
            lock (_attackLock)
            {
                _activeAttacks[createdAttack.Id] = createdAttack;
            }

            result.AttackSpawn = spawnDto;
            return result;
        }

        if (string.IsNullOrWhiteSpace(targetId))
        {
            return result;
        }

        if (_mobManager.TryStrike(targetId, damage, playerId, out var mobUpdate, out var mobDefeated, out var mobName))
        {
            if (mobUpdate != null)
            {
                result.MobUpdate = mobUpdate;
            }

            if (mobDefeated)
            {
                result.PlayerUpdates.Add(GrantExperience(player, _options.MobXpReward, $"{mobName} defeated", now));
            }

            return result;
        }

        if (_environmentManager.TryStrike(targetId, damage, out var updated, out var defeated) && updated != null)
        {
            result.EnvironmentUpdate = updated;
            if (defeated)
            {
                result.PlayerUpdates.Add(GrantExperience(player, _options.SentinelXpReward, "Sentinel defeated", now));
            }
        }

        return result;
    }

    public PlayerStatsUpdate GrantExperience(PlayerState state, int xpAwarded, string reason, DateTime now)
    {
        PlayerStatsDto snapshot;
        bool leveledUp;
        List<AbilityDto> abilities;
        List<PlayerStatUpgradeOption>? upgradeOptions;
        var message = reason;

        lock (state)
        {
            var stats = state.Stats;
            stats.Experience += xpAwarded;
            leveledUp = false;

            while (stats.Experience >= stats.ExperienceToNext)
            {
                stats.Experience -= stats.ExperienceToNext;
                stats.Level++;
                stats.UnspentStatPoints++;
                stats.ExperienceToNext = CalculateExperienceForNext(stats.Level);
                leveledUp = true;
            }

            if (leveledUp)
            {
                stats.CurrentHealth = stats.MaxHealth;
            }

            snapshot = new PlayerStatsDto
            {
                Level = stats.Level,
                Experience = stats.Experience,
                ExperienceToNext = stats.ExperienceToNext,
                ClassId = state.ClassId,
                Strength = stats.Strength,
                Agility = stats.Agility,
                Intelligence = stats.Intelligence,
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                CombatRating = stats.GetCombatRating()
            };

            abilities = BuildAbilitySnapshotsLocked(state, leveledUp, now);
            upgradeOptions = stats.UnspentStatPoints > 0 ? StatUpgradeOptions.ToList() : null;

            if (leveledUp && stats.UnspentStatPoints > 0)
            {
                const string prompt = "Level up! Choose a stat to upgrade.";
                if (string.IsNullOrWhiteSpace(message))
                {
                    message = prompt;
                }
                else if (!message.Contains(prompt, StringComparison.OrdinalIgnoreCase))
                {
                    message = $"{message} {prompt}";
                }
            }
        }

        return new PlayerStatsUpdate(state, snapshot, xpAwarded, leveledUp, message, abilities, upgradeOptions);
    }

    private double CalculateAbilityDamage(PlayerStats stats, AbilityDefinition definition)
    {
        var baseDamage = Math.Max(1.0, stats.Attack * definition.DamageMultiplier + definition.FlatBonusDamage);
        if (definition.ScalingStat.HasValue)
        {
            var attributeValue = stats.GetAttribute(definition.ScalingStat.Value);
            var bonusMultiplier = 1.0 + Math.Max(0, attributeValue) * definition.ScalingCoefficient;
            baseDamage *= bonusMultiplier;
        }

        return Math.Max(1.0, baseDamage);
    }

    private bool TryCreateAttackInstance(
        AbilityDefinition abilityDefinition,
        AttackDescriptor descriptor,
        string playerId,
        double originX,
        double originY,
        double originZ,
        double heading,
        string? targetId,
        double damage,
        out AttackInstance? instance,
        out AttackSpawnDto? spawn)
    {
        instance = null;
        spawn = null;

        if (descriptor.RequiresTarget && string.IsNullOrWhiteSpace(targetId))
        {
            return false;
        }

        var attackId = $"atk-{Guid.NewGuid():N}";
        var attack = new AttackInstance(attackId, descriptor, abilityDefinition.Id, playerId, targetId, damage)
        {
            OriginX = originX,
            OriginY = originY,
            OriginZ = originZ,
            CurrentX = originX,
            CurrentZ = originZ
        };

        AttackTargetType targetType = AttackTargetType.None;
        double targetX = originX;
        double targetZ = originZ;
        bool hasTargetVector = false;

        if (!string.IsNullOrWhiteSpace(targetId))
        {
            if (descriptor.CanHitMobs && _mobManager.TryGetTargetInfo(targetId, out var mobInfo))
            {
                if (!mobInfo.IsAlive)
                {
                    return false;
                }

                targetType = AttackTargetType.Mob;
                targetX = mobInfo.X;
                targetZ = mobInfo.Z;
                hasTargetVector = true;
            }
            else if (descriptor.CanHitEnvironment && _environmentManager.TryGetTargetInfo(targetId, out var envInfo))
            {
                if (!envInfo.IsActive)
                {
                    return false;
                }

                targetType = AttackTargetType.Environment;
                targetX = envInfo.X;
                targetZ = envInfo.Z;
                hasTargetVector = true;
            }
            else if (descriptor.RequiresTarget)
            {
                return false;
            }
        }

        attack.TargetType = targetType;

        double dirX;
        double dirZ;
        if (hasTargetVector)
        {
            dirX = targetX - originX;
            dirZ = targetZ - originZ;
        }
        else
        {
            dirX = Math.Sin(heading);
            dirZ = Math.Cos(heading);
        }

        var length = Math.Sqrt(dirX * dirX + dirZ * dirZ);
        if (length <= 1e-6)
        {
            dirX = Math.Sin(heading);
            dirZ = Math.Cos(heading);
            length = Math.Sqrt(dirX * dirX + dirZ * dirZ);
        }

        if (length <= 1e-6)
        {
            dirX = 0;
            dirZ = 1;
            length = 1;
        }

        attack.DirectionX = dirX / length;
        attack.DirectionZ = dirZ / length;

        var lifetime = descriptor.LifetimeSeconds;
        if (lifetime <= 0)
        {
            if (descriptor.Behavior == AttackBehavior.Projectile && descriptor.Speed > 0)
            {
                lifetime = descriptor.WindupSeconds + descriptor.Range / descriptor.Speed + 0.25;
            }
            else
            {
                lifetime = descriptor.WindupSeconds + 0.45;
            }
        }

        attack.LifetimeSeconds = Math.Max(lifetime, descriptor.WindupSeconds + 0.15);

        instance = attack;

        spawn = new AttackSpawnDto
        {
            AttackId = attackId,
            AbilityId = abilityDefinition.Id,
            OwnerId = playerId,
            Behavior = descriptor.Behavior.ToString(),
            TargetId = targetId,
            OriginX = originX,
            OriginY = originY,
            OriginZ = originZ,
            DirectionX = attack.DirectionX,
            DirectionZ = attack.DirectionZ,
            Radius = descriptor.Radius,
            Range = descriptor.Range,
            Speed = descriptor.Speed,
            WindupSeconds = descriptor.WindupSeconds,
            LifetimeSeconds = attack.LifetimeSeconds
        };

        return true;
    }

    private void ProcessAttacks(TimeSpan delta, DateTime now, WorldTickEventArgs eventArgs)
    {
        var pendingDamage = new List<PendingAttackDamage>();
        List<string>? completedIds = null;
        var deltaSeconds = Math.Clamp(delta.TotalSeconds, 0.01, 0.3);

        lock (_attackLock)
        {
            if (_activeAttacks.Count == 0)
            {
                return;
            }

            foreach (var attack in _activeAttacks.Values)
            {
                var descriptor = attack.Descriptor;
                attack.AgeSeconds += deltaSeconds;

                if (attack.AgeSeconds < descriptor.WindupSeconds)
                {
                    attack.CurrentX = attack.OriginX;
                    attack.CurrentZ = attack.OriginZ;
                }
                else
                {
                    switch (descriptor.Behavior)
                    {
                        case AttackBehavior.Melee:
                            if (!attack.HasTriggeredDamage)
                            {
                                ProcessMeleeAttack(attack, pendingDamage);
                            }
                            attack.Completed = true;
                            break;

                        case AttackBehavior.Sweep:
                            if (!attack.HasTriggeredDamage)
                            {
                                ProcessSweepAttack(attack, pendingDamage);
                            }
                            break;

                        case AttackBehavior.Projectile:
                            ProcessProjectileAttack(attack, deltaSeconds, pendingDamage);
                            break;
                    }
                }

                var lifetime = Math.Max(attack.LifetimeSeconds, descriptor.WindupSeconds + 0.2);
                if (attack.AgeSeconds >= lifetime || attack.Completed)
                {
                    (completedIds ??= new List<string>()).Add(attack.Id);
                }
                else
                {
                    eventArgs.AttackSnapshots.Add(new AttackSnapshotDto
                    {
                        AttackId = attack.Id,
                        AbilityId = attack.AbilityId,
                        Behavior = descriptor.Behavior.ToString(),
                        X = attack.CurrentX,
                        Z = attack.CurrentZ,
                        Radius = descriptor.Radius,
                        Progress = Math.Clamp(attack.AgeSeconds / lifetime, 0, 1)
                    });
                }
            }

            if (completedIds != null)
            {
                foreach (var id in completedIds)
                {
                    _activeAttacks.Remove(id);
                }
            }
        }

        foreach (var pending in pendingDamage)
        {
            switch (pending.TargetType)
            {
                case AttackTargetType.Mob:
                    ApplyDamageToMob(pending.Attack, pending.TargetId, now, eventArgs);
                    break;
                case AttackTargetType.Environment:
                    ApplyDamageToEnvironment(pending.Attack, pending.TargetId, now, eventArgs);
                    break;
            }
        }

        if (completedIds != null)
        {
            eventArgs.CompletedAttackIds.AddRange(completedIds);
        }
    }

    private void ProcessMeleeAttack(AttackInstance attack, List<PendingAttackDamage> pendingDamage)
    {
        attack.CurrentX = attack.OriginX;
        attack.CurrentZ = attack.OriginZ;
        attack.HasTriggeredDamage = true;

        var descriptor = attack.Descriptor;
        var rangeSq = Math.Max(0.01, descriptor.Range * descriptor.Range);

        if (!string.IsNullOrWhiteSpace(attack.TargetId))
        {
            if (attack.TargetType != AttackTargetType.Environment && descriptor.CanHitMobs &&
                _mobManager.TryGetTargetInfo(attack.TargetId, out var mobInfo) && mobInfo.IsAlive)
            {
                var dx = mobInfo.X - attack.OriginX;
                var dz = mobInfo.Z - attack.OriginZ;
                if (dx * dx + dz * dz <= rangeSq && attack.HitTargets.Add(attack.TargetId))
                {
                    pendingDamage.Add(new PendingAttackDamage(attack, attack.TargetId, AttackTargetType.Mob));
                }
            }
            else if (attack.TargetType != AttackTargetType.Mob && descriptor.CanHitEnvironment &&
                     _environmentManager.TryGetTargetInfo(attack.TargetId, out var envInfo) && envInfo.IsActive)
            {
                var dx = envInfo.X - attack.OriginX;
                var dz = envInfo.Z - attack.OriginZ;
                if (dx * dx + dz * dz <= rangeSq && attack.HitTargets.Add(attack.TargetId))
                {
                    pendingDamage.Add(new PendingAttackDamage(attack, attack.TargetId, AttackTargetType.Environment));
                }
            }
        }
        else
        {
            ProcessAreaHits(attack, attack.OriginX, attack.OriginZ, descriptor.Range, pendingDamage);
        }
    }

    private void ProcessSweepAttack(AttackInstance attack, List<PendingAttackDamage> pendingDamage)
    {
        attack.CurrentX = attack.OriginX;
        attack.CurrentZ = attack.OriginZ;
        if (!attack.HasTriggeredDamage)
        {
            ProcessAreaHits(attack, attack.OriginX, attack.OriginZ, attack.Descriptor.Range, pendingDamage);
            attack.HasTriggeredDamage = true;
        }
    }

    private void ProcessProjectileAttack(AttackInstance attack, double deltaSeconds, List<PendingAttackDamage> pendingDamage)
    {
        var descriptor = attack.Descriptor;
        if (descriptor.Speed <= 0)
        {
            attack.CurrentX = attack.OriginX;
            attack.CurrentZ = attack.OriginZ;
            if (!attack.HasTriggeredDamage)
            {
                ProcessAreaHits(attack, attack.CurrentX, attack.CurrentZ, descriptor.Radius, pendingDamage);
                if (attack.HitTargets.Count > 0)
                {
                    attack.HasTriggeredDamage = true;
                }
            }
            attack.Completed = true;
            return;
        }

        var travel = Math.Max(0, descriptor.Speed * deltaSeconds);
        var remaining = Math.Max(0, descriptor.Range - attack.DistanceTravelled);
        if (travel > remaining)
        {
            travel = remaining;
        }

        attack.DistanceTravelled += travel;
        attack.CurrentX += attack.DirectionX * travel;
        attack.CurrentZ += attack.DirectionZ * travel;

        if (attack.DistanceTravelled >= descriptor.Range)
        {
            attack.Completed = true;
        }

        ProcessAreaHits(attack, attack.CurrentX, attack.CurrentZ, descriptor.Radius, pendingDamage);

        if (attack.HitTargets.Count > 0)
        {
            attack.HasTriggeredDamage = true;
            if (!descriptor.HitsMultipleTargets)
            {
                attack.Completed = true;
            }
        }
    }

    private void ProcessAreaHits(AttackInstance attack, double centerX, double centerZ, double radius, List<PendingAttackDamage> pendingDamage)
    {
        var descriptor = attack.Descriptor;
        var effectiveRadius = Math.Max(radius, descriptor.Radius);
        if (effectiveRadius <= 0)
        {
            effectiveRadius = 0.8;
        }

        if (descriptor.CanHitMobs)
        {
            var mobs = _mobManager.CollectTargetsInRange(centerX, centerZ, effectiveRadius);
            foreach (var mob in mobs)
            {
                if (!attack.HitTargets.Add(mob.Id))
                {
                    continue;
                }

                pendingDamage.Add(new PendingAttackDamage(attack, mob.Id, AttackTargetType.Mob));
                if (!descriptor.HitsMultipleTargets)
                {
                    return;
                }
            }
        }

        if (descriptor.CanHitEnvironment)
        {
            var environments = _environmentManager.CollectTargetsInRange(centerX, centerZ, effectiveRadius);
            foreach (var env in environments)
            {
                if (!attack.HitTargets.Add(env.Id))
                {
                    continue;
                }

                pendingDamage.Add(new PendingAttackDamage(attack, env.Id, AttackTargetType.Environment));
                if (!descriptor.HitsMultipleTargets)
                {
                    return;
                }
            }
        }
    }

    private void ApplyDamageToMob(AttackInstance attack, string targetId, DateTime now, WorldTickEventArgs eventArgs)
    {
        if (!_mobManager.TryStrike(targetId, attack.Damage, attack.OwnerPlayerId, out var mobUpdate, out var defeated, out var mobName))
        {
            return;
        }

        if (mobUpdate != null)
        {
            eventArgs.MobUpdates.Add(mobUpdate);
        }

        if (defeated && _players.TryGetValue(attack.OwnerPlayerId, out var owner))
        {
            var xpUpdate = GrantExperience(owner, _options.MobXpReward, $"{mobName} defeated", now);
            eventArgs.PlayerStatUpdates.Add(xpUpdate);
        }
    }

    private void ApplyDamageToEnvironment(AttackInstance attack, string targetId, DateTime now, WorldTickEventArgs eventArgs)
    {
        if (!_environmentManager.TryStrike(targetId, attack.Damage, out var updated, out var defeated) || updated == null)
        {
            return;
        }

        eventArgs.EnvironmentUpdates.Add(updated);

        if (defeated && _players.TryGetValue(attack.OwnerPlayerId, out var owner))
        {
            var xpUpdate = GrantExperience(owner, _options.SentinelXpReward, "Sentinel defeated", now);
            eventArgs.PlayerStatUpdates.Add(xpUpdate);
        }
    }

    public PlayerStatsUpdate? ApplyStatUpgrade(string playerId, string statId, DateTime now)
    {
        if (!TryGetPlayer(playerId, out var state) || state is null)
        {
            return null;
        }

        return ApplyStatUpgrade(state, statId, now);
    }

    public PlayerStatsUpdate? SelectPlayerClass(string playerId, string classId, DateTime now)
    {
        if (!TryGetPlayer(playerId, out var state) || state is null)
        {
            return null;
        }

        return SelectPlayerClass(state, classId, now);
    }

    public PlayerStatsUpdate? ApplyStatUpgrade(PlayerState state, string statId, DateTime now)
    {
        PlayerStatsDto snapshot;
        List<AbilityDto> abilities;
        List<PlayerStatUpgradeOption>? upgradeOptions;
        string message;

        lock (state)
        {
            var stats = state.Stats;
            if (stats.UnspentStatPoints <= 0)
            {
                return null;
            }

            if (!TryApplyStatUpgradeLocked(stats, statId, out message))
            {
                return null;
            }

            snapshot = new PlayerStatsDto
            {
                Level = stats.Level,
                Experience = stats.Experience,
                ExperienceToNext = stats.ExperienceToNext,
                ClassId = state.ClassId,
                Strength = stats.Strength,
                Agility = stats.Agility,
                Intelligence = stats.Intelligence,
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                CombatRating = stats.GetCombatRating()
            };

            abilities = BuildAbilitySnapshotsLocked(state, leveledUp: false, now);
            upgradeOptions = stats.UnspentStatPoints > 0 ? StatUpgradeOptions.ToList() : null;
        }

        return new PlayerStatsUpdate(state, snapshot, 0, false, message, abilities, upgradeOptions);
    }

    public PlayerStatsUpdate? SelectPlayerClass(PlayerState state, string classId, DateTime now)
    {
        if (string.IsNullOrWhiteSpace(classId))
        {
            return null;
        }

        PlayerStatsDto snapshot;
        List<AbilityDto> abilities;
        List<PlayerStatUpgradeOption>? upgradeOptions;
        string reason;

        lock (state)
        {
            var classDefinition = _classDefinitions.FirstOrDefault(c =>
                string.Equals(c.Id, classId, StringComparison.OrdinalIgnoreCase));

            if (classDefinition == null)
            {
                return null;
            }

            if (!string.IsNullOrWhiteSpace(state.ClassId) &&
                string.Equals(state.ClassId, classDefinition.Id, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            state.ClassId = classDefinition.Id;
            state.Stats.ApplyClass(classDefinition);
            state.Stats.RecalculateDerivedStats();
            state.Stats.CurrentHealth = state.Stats.MaxHealth;

            foreach (var definition in _abilityDefinitions)
            {
                if (!state.Abilities.TryGetValue(definition.Id, out var abilityState))
                {
                    abilityState = new PlayerAbilityState
                    {
                        AbilityId = definition.Id,
                        CooldownUntil = now,
                        Unlocked = false
                    };
                    state.Abilities[definition.Id] = abilityState;
                }

                var unlocked = IsAbilityAvailableToPlayer(state, definition);
                abilityState.Unlocked = unlocked;
                if (unlocked)
                {
                    abilityState.CooldownUntil = now;
                }
            }

            snapshot = new PlayerStatsDto
            {
                Level = state.Stats.Level,
                Experience = state.Stats.Experience,
                ExperienceToNext = state.Stats.ExperienceToNext,
                ClassId = state.ClassId,
                Strength = state.Stats.Strength,
                Agility = state.Stats.Agility,
                Intelligence = state.Stats.Intelligence,
                Attack = state.Stats.Attack,
                MaxHealth = state.Stats.MaxHealth,
                CurrentHealth = state.Stats.CurrentHealth,
                AttackSpeed = state.Stats.AttackSpeed,
                UnspentStatPoints = state.Stats.UnspentStatPoints,
                CombatRating = state.Stats.GetCombatRating()
            };

            abilities = BuildAbilitySnapshotsLocked(state, leveledUp: false, now);
            upgradeOptions = state.Stats.UnspentStatPoints > 0 ? StatUpgradeOptions.ToList() : null;
            reason = $"You have embraced the path of the {classDefinition.Name}.";
        }

        return new PlayerStatsUpdate(state, snapshot, 0, false, reason, abilities, upgradeOptions);
    }

    private static bool TryApplyStatUpgradeLocked(PlayerStats stats, string statId, out string message)
    {
        message = string.Empty;

        if (string.IsNullOrWhiteSpace(statId))
        {
            return false;
        }

        switch (statId.Trim().ToLowerInvariant())
        {
            case "strength":
                stats.Strength += 2;
                message = "Strength increased!";
                break;
            case "agility":
                stats.Agility += 2;
                message = "Agility increased!";
                break;
            case "intelligence":
                stats.Intelligence += 2;
                message = "Intelligence increased!";
                break;
            default:
                return false;
        }

        stats.RecalculateDerivedStats();
        stats.CurrentHealth = stats.MaxHealth;

        if (stats.UnspentStatPoints > 0)
        {
            stats.UnspentStatPoints--;
        }

        return true;
    }

    public PlayerRespawnUpdate HandlePlayerDefeat(PlayerState state, string mobName, DateTime now)
    {
        PlayerStatsDto snapshot;
        List<AbilityDto> abilities;
        List<PlayerStatUpgradeOption>? upgradeOptions;

        var spawnX = 0.0;
        var spawnZ = 0.0;
        var spawnY = SampleTerrainHeight(spawnX, spawnZ) + 2.0;

        lock (state)
        {
            state.X = spawnX;
            state.Z = spawnZ;
            state.Y = spawnY;
            state.VelocityX = 0;
            state.VelocityZ = 0;
            state.LastUpdate = DateTime.UtcNow;
            state.Stats.CurrentHealth = state.Stats.MaxHealth;

            snapshot = new PlayerStatsDto
            {
                Level = state.Stats.Level,
                Experience = state.Stats.Experience,
                ExperienceToNext = state.Stats.ExperienceToNext,
                ClassId = state.ClassId,
                Strength = state.Stats.Strength,
                Agility = state.Stats.Agility,
                Intelligence = state.Stats.Intelligence,
                Attack = state.Stats.Attack,
                MaxHealth = state.Stats.MaxHealth,
                CurrentHealth = state.Stats.CurrentHealth,
                AttackSpeed = state.Stats.AttackSpeed,
                UnspentStatPoints = state.Stats.UnspentStatPoints,
                CombatRating = state.Stats.GetCombatRating()
            };

            abilities = BuildAbilitySnapshotsLocked(state, leveledUp: false, now);
            upgradeOptions = state.Stats.UnspentStatPoints > 0 ? StatUpgradeOptions.ToList() : null;
        }

        var playerSnapshot = CreatePlayerSnapshot(state);
        var statsUpdate = new PlayerStatsUpdate(state, snapshot, 0, false, $"You were defeated by {mobName}.", abilities, upgradeOptions);
        return new PlayerRespawnUpdate(playerSnapshot, statsUpdate);
    }

    public PlayerDamageResult ProcessMobDamage(PlayerState state, double damage, string mobName, DateTime now)
    {
        PlayerStatsDto snapshot;
        bool defeated;
        string? reason;
        List<PlayerStatUpgradeOption>? upgradeOptions;

        lock (state)
        {
            var stats = state.Stats;
            var appliedDamage = Math.Max(1, (int)Math.Round(damage));
            stats.CurrentHealth = Math.Max(0, stats.CurrentHealth - appliedDamage);
            defeated = stats.CurrentHealth <= 0;

            snapshot = new PlayerStatsDto
            {
                Level = stats.Level,
                Experience = stats.Experience,
                ExperienceToNext = stats.ExperienceToNext,
                ClassId = state.ClassId,
                Strength = stats.Strength,
                Agility = stats.Agility,
                Intelligence = stats.Intelligence,
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                CombatRating = stats.GetCombatRating()
            };

            reason = defeated ? null : $"{mobName} hit you for {appliedDamage}.";
            upgradeOptions = stats.UnspentStatPoints > 0 ? StatUpgradeOptions.ToList() : null;
        }

        var update = new PlayerStatsUpdate(state, snapshot, 0, false, reason, null, upgradeOptions);
        return new PlayerDamageResult(update, defeated);
    }

    public double AdvanceWorldClock(TimeSpan delta)
    {
        lock (_worldClockLock)
        {
            var increment = delta.TotalSeconds / _options.DayLengthSeconds;
            _timeOfDayFraction = (_timeOfDayFraction + increment) % 1.0;
            if (_timeOfDayFraction < 0)
            {
                _timeOfDayFraction += 1.0;
            }

            return _timeOfDayFraction;
        }
    }

    public double GetTimeOfDayFraction()
    {
        lock (_worldClockLock)
        {
            return _timeOfDayFraction;
        }
    }

    private void WorldTick(object? _)
    {
        var now = DateTime.UtcNow;
        var delta = now - _lastWorldTick;
        if (delta.TotalSeconds <= 0)
        {
            delta = TimeSpan.FromMilliseconds(100);
        }
        _lastWorldTick = now;

        if (_players.IsEmpty)
        {
            return;
        }

        var respawns = _environmentManager.CollectRespawns();
        var observations = BuildPlayerObservations();
        var mobResult = _mobManager.Tick(delta, observations, SampleTerrainHeight);
        var timeOfDay = AdvanceWorldClock(delta);

        var eventArgs = new WorldTickEventArgs(timeOfDay);

        if (respawns.Count > 0)
        {
            eventArgs.EnvironmentUpdates.AddRange(respawns);
        }

        if (mobResult.Updates.Count > 0)
        {
            eventArgs.MobUpdates.AddRange(mobResult.Updates);
        }

        foreach (var attack in mobResult.Attacks)
        {
            if (_players.TryGetValue(attack.PlayerId, out var playerState))
            {
                var damageResult = ProcessMobDamage(playerState, attack.Damage, attack.MobName, now);
                eventArgs.PlayerStatUpdates.Add(damageResult.Update);

                if (damageResult.Defeated)
                {
                    var respawn = HandlePlayerDefeat(playerState, attack.MobName, now);
                    eventArgs.PlayerRespawns.Add(respawn);
                }
            }

            eventArgs.MobAttacks.Add(attack);
        }

        ProcessAttacks(delta, now, eventArgs);

        if (eventArgs.HasChanges)
        {
            WorldTicked?.Invoke(this, eventArgs);
        }
        else
        {
            // Still notify listeners about time of day progression to keep clients in sync.
            WorldTicked?.Invoke(this, eventArgs);
        }
    }

    private Dictionary<string, PlayerObservation> BuildPlayerObservations()
    {
        var observations = new Dictionary<string, PlayerObservation>(_players.Count);

        foreach (var kvp in _players)
        {
            var state = kvp.Value;
            lock (state)
            {
                observations[state.Id] = new PlayerObservation(
                    state.Id,
                    state.X,
                    state.Y,
                    state.Z,
                    state.Stats.CurrentHealth);
            }
        }

        return observations;
    }

    private ChunkData GetOrGenerateChunk(int cx, int cz)
    {
        return _chunkCache.GetOrAdd((cx, cz), key => GenerateChunkData(key.Item1, key.Item2));
    }

    private ChunkData GenerateChunkData(int cx, int cz)
    {
        var vertices = new List<Vertex>((_options.ChunkSize + 1) * (_options.ChunkSize + 1));

        for (var z = 0; z <= _options.ChunkSize; z++)
        {
            for (var x = 0; x <= _options.ChunkSize; x++)
            {
                var worldX = cx * _options.ChunkSize + x;
                var worldZ = cz * _options.ChunkSize + z;
                var height = SampleTerrainHeight(worldX, worldZ);

                vertices.Add(new Vertex
                {
                    X = worldX,
                    Y = height,
                    Z = worldZ
                });
            }
        }

        var worldObjects = GenerateEnvironmentAndMobBlueprints(cx, cz);
        return new ChunkData(vertices, worldObjects.EnvironmentBlueprints, worldObjects.MobBlueprints);
    }

    private (List<EnvironmentBlueprint> EnvironmentBlueprints, List<MobBlueprint> MobBlueprints) GenerateEnvironmentAndMobBlueprints(int cx, int cz)
    {
        var seed = HashCode.Combine(cx, cz, _options.WorldSeed);
        var rng = new Random(seed);
        var count = rng.Next(4, 9);
        var environmentBlueprints = new List<EnvironmentBlueprint>(count);
        var mobBlueprints = new List<MobBlueprint>();
        var averages = GetAveragePlayerAttributes();

        for (var i = 0; i < count; i++)
        {
            var offsetX = rng.NextDouble() * _options.ChunkSize;
            var offsetZ = rng.NextDouble() * _options.ChunkSize;

            var worldX = cx * _options.ChunkSize + offsetX;
            var worldZ = cz * _options.ChunkSize + offsetZ;
            var worldY = SampleTerrainHeight(worldX, worldZ);

            var typeRoll = rng.NextDouble();
            if (typeRoll < 0.68)
            {
                var blueprint = new EnvironmentBlueprint
                {
                    Id = $"env-{cx}-{cz}-{i}",
                    ChunkX = cx,
                    ChunkZ = cz,
                    Type = "tree",
                    X = worldX,
                    Y = worldY,
                    Z = worldZ,
                    Rotation = rng.NextDouble() * Math.PI * 2
                };

                environmentBlueprints.Add(blueprint);
                _environmentManager.EnsureBlueprint(blueprint);
            }
            else
            {
                var archetype = ChooseMobArchetype(rng, averages);
                var mobStats = BuildMobStatBlock(archetype, rng, averages);
                var mobBlueprint = new MobBlueprint
                {
                    Id = $"mob-{cx}-{cz}-{i}",
                    ChunkX = cx,
                    ChunkZ = cz,
                    Type = archetype.TypeId,
                    ArchetypeId = archetype.Id,
                    Name = archetype.GetName(rng),
                    X = worldX,
                    Y = worldY,
                    Z = worldZ,
                    Stats = mobStats
                };

                mobBlueprints.Add(mobBlueprint);
                _mobManager.EnsureBlueprint(mobBlueprint);
            }
        }

        return (environmentBlueprints, mobBlueprints);
    }

    private AttributeAverages GetAveragePlayerAttributes()
    {
        double totalStrength = 0;
        double totalAgility = 0;
        double totalIntelligence = 0;
        var count = 0;

        foreach (var kvp in _players)
        {
            var state = kvp.Value;
            lock (state)
            {
                if (string.IsNullOrWhiteSpace(state.ClassId))
                {
                    continue;
                }

                totalStrength += state.Stats.Strength;
                totalAgility += state.Stats.Agility;
                totalIntelligence += state.Stats.Intelligence;
                count++;
            }
        }

        if (count == 0)
        {
            return new AttributeAverages(18, 18, 18);
        }

        return new AttributeAverages(
            totalStrength / count,
            totalAgility / count,
            totalIntelligence / count);
    }

    private MobArchetype ChooseMobArchetype(Random rng, AttributeAverages averages)
    {
        var weighted = new List<(MobArchetype Archetype, double Weight)>(_mobArchetypes.Length);

        foreach (var archetype in _mobArchetypes)
        {
            var target = averages.Get(archetype.PrimaryAttribute);
            var midpoint = archetype.GetRange(archetype.PrimaryAttribute).Midpoint;
            var difference = Math.Abs(target - midpoint);
            var weight = 1.0 / (1.0 + difference);
            weighted.Add((archetype, Math.Max(0.1, weight)));
        }

        var total = weighted.Sum(w => w.Weight);
        var roll = rng.NextDouble() * total;
        var cumulative = 0.0;

        foreach (var entry in weighted)
        {
            cumulative += entry.Weight;
            if (roll <= cumulative)
            {
                return entry.Archetype;
            }
        }

        return weighted[weighted.Count - 1].Archetype;
    }

    private MobStatBlock BuildMobStatBlock(MobArchetype archetype, Random rng, AttributeAverages averages)
    {
        var strength = SampleStat(archetype.GetRange(PlayerAttribute.Strength), averages.Strength, rng);
        var agility = SampleStat(archetype.GetRange(PlayerAttribute.Agility), averages.Agility, rng);
        var intelligence = SampleStat(archetype.GetRange(PlayerAttribute.Intelligence), averages.Intelligence, rng);

        var maxHealth = Math.Max(archetype.BaseHealth, archetype.BaseHealth + strength * 9 + intelligence * 5);
        var attackDamage = Math.Max(archetype.BaseDamage, archetype.BaseDamage + strength * 1.6 + intelligence * 0.9);
        var attackInterval = Math.Clamp(archetype.BaseInterval - agility * 0.025, 1.2, 3.6);
        var moveSpeed = Math.Max(2.0, archetype.MoveSpeed + agility * 0.02);
        var aggroRange = Math.Max(8.0, archetype.AggroRange + intelligence * 0.05);
        var attackRange = Math.Max(2.0, archetype.AttackRange + intelligence * 0.03);

        return new MobStatBlock
        {
            Strength = strength,
            Agility = agility,
            Intelligence = intelligence,
            MaxHealth = Math.Round(maxHealth, 2),
            AttackDamage = Math.Round(attackDamage, 2),
            AttackInterval = Math.Round(attackInterval, 2),
            MoveSpeed = Math.Round(moveSpeed, 2),
            AggroRange = Math.Round(aggroRange, 2),
            AttackRange = Math.Round(attackRange, 2)
        };
    }

    private static int SampleStat(StatRange range, double target, Random rng)
    {
        var midpoint = range.Midpoint;
        var anchor = double.IsFinite(target) ? target : midpoint;
        var variance = Math.Max(1.0, (range.Max - range.Min) / 3.0);
        var sample = anchor + (rng.NextDouble() - 0.5) * variance * 2.0;
        var value = (int)Math.Round(sample, MidpointRounding.AwayFromZero);
        return (int)Math.Clamp(value, range.Min, range.Max);
    }

    private readonly struct AttributeAverages
    {
        public AttributeAverages(double strength, double agility, double intelligence)
        {
            Strength = strength;
            Agility = agility;
            Intelligence = intelligence;
        }

        public double Strength { get; }
        public double Agility { get; }
        public double Intelligence { get; }

        public double Get(PlayerAttribute attribute) => attribute switch
        {
            PlayerAttribute.Strength => Strength,
            PlayerAttribute.Agility => Agility,
            PlayerAttribute.Intelligence => Intelligence,
            _ => Strength
        };
    }

    private readonly struct StatRange
    {
        public StatRange(int min, int max)
        {
            Min = min;
            Max = max;
        }

        public int Min { get; }
        public int Max { get; }
        public double Midpoint => (Min + Max) / 2.0;
    }

    private sealed class MobArchetype
    {
        public MobArchetype(
            string id,
            string typeId,
            PlayerAttribute primaryAttribute,
            StatRange strengthRange,
            StatRange agilityRange,
            StatRange intelligenceRange,
            double baseHealth,
            double baseDamage,
            double baseInterval,
            double moveSpeed,
            double aggroRange,
            double attackRange,
            IEnumerable<string> names)
        {
            Id = id;
            TypeId = typeId;
            PrimaryAttribute = primaryAttribute;
            StrengthRange = strengthRange;
            AgilityRange = agilityRange;
            IntelligenceRange = intelligenceRange;
            BaseHealth = baseHealth;
            BaseDamage = baseDamage;
            BaseInterval = baseInterval;
            MoveSpeed = moveSpeed;
            AggroRange = aggroRange;
            AttackRange = attackRange;
            Names = names?.ToArray() ?? Array.Empty<string>();
        }

        public string Id { get; }
        public string TypeId { get; }
        public PlayerAttribute PrimaryAttribute { get; }
        public StatRange StrengthRange { get; }
        public StatRange AgilityRange { get; }
        public StatRange IntelligenceRange { get; }
        public double BaseHealth { get; }
        public double BaseDamage { get; }
        public double BaseInterval { get; }
        public double MoveSpeed { get; }
        public double AggroRange { get; }
        public double AttackRange { get; }
        public IReadOnlyList<string> Names { get; }

        public StatRange GetRange(PlayerAttribute attribute) => attribute switch
        {
            PlayerAttribute.Strength => StrengthRange,
            PlayerAttribute.Agility => AgilityRange,
            PlayerAttribute.Intelligence => IntelligenceRange,
            _ => StrengthRange
        };

        public string GetName(Random rng)
        {
            if (Names.Count == 0)
            {
                return TypeId;
            }

            var index = rng.Next(Names.Count);
            return Names[index];
        }
    }

    private static int CalculateExperienceForNext(int level)
    {
        return 80 + Math.Max(0, level - 1) * 35;
    }

    private List<AbilityDto> BuildAbilitySnapshotsLocked(PlayerState state, bool leveledUp, DateTime now)
    {
        var list = new List<AbilityDto>(_abilityDefinitions.Length);

        foreach (var definition in _abilityDefinitions)
        {
            if (!state.Abilities.TryGetValue(definition.Id, out var abilityState))
            {
                abilityState = new PlayerAbilityState
                {
                    AbilityId = definition.Id,
                    Unlocked = false,
                    CooldownUntil = now
                };
                state.Abilities[definition.Id] = abilityState;
            }

            if (leveledUp && definition.ResetOnLevelUp)
            {
                abilityState.CooldownUntil = now;
            }

            var unlocked = IsAbilityAvailableToPlayer(state, definition);
            if (unlocked && !abilityState.Unlocked)
            {
                abilityState.CooldownUntil = now;
            }

            abilityState.Unlocked = unlocked;

            var cooldownRemaining = Math.Max(0, (abilityState.CooldownUntil - now).TotalSeconds);

            list.Add(new AbilityDto
            {
                AbilityId = definition.Id,
                Name = definition.Name,
                Key = definition.Key,
                CooldownSeconds = cooldownRemaining,
                Unlocked = abilityState.Unlocked,
                Available = abilityState.Unlocked && cooldownRemaining <= 0,
                ResetOnLevelUp = definition.ResetOnLevelUp,
                Range = definition.Attack?.Range ?? 6,
                AutoCast = definition.AutoCast,
                Priority = definition.Priority,
                RequiredClassId = definition.RequiredClassId,
                ScalingStat = definition.ScalingStat?.ToString().ToLowerInvariant()
            });
        }

        return list;
    }

    private static bool IsAbilityAvailableToPlayer(PlayerState state, AbilityDefinition definition)
    {
        if (!string.IsNullOrWhiteSpace(definition.RequiredClassId))
        {
            if (!string.Equals(state.ClassId, definition.RequiredClassId, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        return state.Stats.Level >= definition.UnlockLevel;
    }

    private double SampleTerrainHeight(double x, double z)
    {
        return LayeredPerlin2D(
            x,
            z,
            _options.TerrainOctaves,
            _options.TerrainPersistence,
            _options.TerrainBaseFrequency,
            _options.TerrainBaseAmplitude);
    }

    private static double LayeredPerlin2D(double x, double y, int octaves, double persistence, double baseFrequency, double baseAmplitude)
    {
        var total = 0.0;
        var frequency = baseFrequency;
        var amplitude = baseAmplitude;

        for (var i = 0; i < octaves; i++)
        {
            var noiseValue = Perlin.Noise2D(x * frequency, y * frequency);
            total += noiseValue * amplitude;
            frequency *= 2.0;
            amplitude *= persistence;
        }

        return total;
    }

    public void Dispose()
    {
        _worldTimer.Dispose();
    }
}

public sealed class WorldTickEventArgs : EventArgs
{
    public WorldTickEventArgs(double timeOfDay)
    {
        TimeOfDay = timeOfDay;
    }

    public double TimeOfDay { get; }
    public List<EnvironmentObjectDto> EnvironmentUpdates { get; } = new();
    public List<MobSnapshotDto> MobUpdates { get; } = new();
    public List<MobAttackEvent> MobAttacks { get; } = new();
    public List<PlayerStatsUpdate> PlayerStatUpdates { get; } = new();
    public List<PlayerRespawnUpdate> PlayerRespawns { get; } = new();
    public List<AttackSnapshotDto> AttackSnapshots { get; } = new();
    public List<string> CompletedAttackIds { get; } = new();

    public bool HasChanges =>
        EnvironmentUpdates.Count > 0 ||
        MobUpdates.Count > 0 ||
        MobAttacks.Count > 0 ||
        PlayerStatUpdates.Count > 0 ||
        PlayerRespawns.Count > 0 ||
        AttackSnapshots.Count > 0 ||
        CompletedAttackIds.Count > 0;
}

public sealed class NearbyChunksResult
{
    public NearbyChunksResult(int centerChunkX, int centerChunkZ, int chunkSize, IReadOnlyList<ChunkEnvelope> chunks)
    {
        CenterChunkX = centerChunkX;
        CenterChunkZ = centerChunkZ;
        ChunkSize = chunkSize;
        Chunks = chunks;
    }

    public int CenterChunkX { get; }
    public int CenterChunkZ { get; }
    public int ChunkSize { get; }
    public IReadOnlyList<ChunkEnvelope> Chunks { get; }
}

public sealed class ChunkEnvelope
{
    public ChunkEnvelope(int x, int z, IReadOnlyList<Vertex> vertices, IReadOnlyList<EnvironmentObjectDto> environment, IReadOnlyList<MobSnapshotDto> mobs)
    {
        X = x;
        Z = z;
        Vertices = vertices;
        EnvironmentObjects = environment;
        Mobs = mobs;
    }

    public int X { get; }
    public int Z { get; }
    public IReadOnlyList<Vertex> Vertices { get; }
    public IReadOnlyList<EnvironmentObjectDto> EnvironmentObjects { get; }
    public IReadOnlyList<MobSnapshotDto> Mobs { get; }
}

public sealed class AbilityExecutionResult
{
    public AbilityExecutionResult(string abilityId, string? targetId)
    {
        AbilityId = abilityId;
        TargetId = targetId;
    }

    public string AbilityId { get; }
    public string? TargetId { get; }
    public bool AbilityTriggered { get; set; }
    public MobSnapshotDto? MobUpdate { get; set; }
    public EnvironmentObjectDto? EnvironmentUpdate { get; set; }
    public List<PlayerStatsUpdate> PlayerUpdates { get; } = new();
    public AttackSpawnDto? AttackSpawn { get; set; }
}

public sealed class PlayerStatsUpdate
{
    public PlayerStatsUpdate(
        PlayerState player,
        PlayerStatsDto snapshot,
        int experienceAwarded,
        bool leveledUp,
        string? reason,
        IReadOnlyList<AbilityDto>? abilities,
        IReadOnlyList<PlayerStatUpgradeOption>? upgradeOptions)
    {
        Player = player;
        Snapshot = snapshot;
        ExperienceAwarded = experienceAwarded;
        LeveledUp = leveledUp;
        Reason = reason;
        Abilities = abilities;
        UpgradeOptions = upgradeOptions;
    }

    public PlayerState Player { get; }
    public PlayerStatsDto Snapshot { get; }
    public int ExperienceAwarded { get; }
    public bool LeveledUp { get; }
    public string? Reason { get; }
    public IReadOnlyList<AbilityDto>? Abilities { get; }
    public IReadOnlyList<PlayerStatUpgradeOption>? UpgradeOptions { get; }
}

public sealed class PlayerRespawnUpdate
{
    public PlayerRespawnUpdate(PlayerSnapshot snapshot, PlayerStatsUpdate statsUpdate)
    {
        Snapshot = snapshot;
        StatsUpdate = statsUpdate;
    }

    public PlayerSnapshot Snapshot { get; }
    public PlayerStatsUpdate StatsUpdate { get; }
}

readonly struct PendingAttackDamage
{
    public PendingAttackDamage(AttackInstance attack, string targetId, AttackTargetType targetType)
    {
        Attack = attack;
        TargetId = targetId;
        TargetType = targetType;
    }

    public AttackInstance Attack { get; }
    public string TargetId { get; }
    public AttackTargetType TargetType { get; }
}

public readonly struct PlayerDamageResult
{
    public PlayerDamageResult(PlayerStatsUpdate update, bool defeated)
    {
        Update = update;
        Defeated = defeated;
    }

    public PlayerStatsUpdate Update { get; }
    public bool Defeated { get; }
}
