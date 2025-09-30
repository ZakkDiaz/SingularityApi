using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Singularity.Core;

public sealed class GameWorld : IDisposable
{
    private readonly GameWorldOptions _options;
    private readonly ConcurrentDictionary<(int, int), ChunkData> _chunkCache = new();
    private readonly ConcurrentDictionary<string, PlayerState> _players = new();
    private readonly EnvironmentManager _environmentManager;
    private readonly MobManager _mobManager;
    private const int MaxWeaponSlots = 3;
    private readonly AbilityDefinition[] _abilityDefinitions;
    private readonly Dictionary<string, AbilityDefinition> _abilityDefinitionMap;
    private readonly object _attackLock = new();
    private readonly Dictionary<string, AttackInstance> _activeAttacks = new();
    private const double PlayerHeightOffset = 1.4;
    private static readonly PlayerStatUpgradeOption[] StatUpgradeOptions =
    {
        new()
        {
            Id = "attack",
            Name = "Power",
            Description = "+2 attack"
        },
        new()
        {
            Id = "maxHealth",
            Name = "Vitality",
            Description = "+10 max health"
        },
        new()
        {
            Id = "attackSpeed",
            Name = "Finesse",
            Description = "10% faster attacks"
        },
        new()
        {
            Id = "moveSpeed",
            Name = "Swiftness",
            Description = "+1 move speed"
        }
    };
    private static readonly Dictionary<string, PlayerStatUpgradeOption> StatUpgradeMap = StatUpgradeOptions
        .ToDictionary(option => option.Id, StringComparer.OrdinalIgnoreCase);
    private const int WalkSize = 10;
    private const double TileSize = 40.0;
    private const double HeightStep = TileSize * 0.5;
    private const double MaxTerrainStepHeight = HeightStep * 0.75;
    private const int MinWalkDepth = -4;
    private const int MaxWalkDepth = 5;
    private readonly Timer _worldTimer;
    private DateTime _lastWorldTick = DateTime.UtcNow;
    private double _timeOfDayFraction = 0.25;
    private readonly object _worldClockLock = new();
    private readonly double[,] _cellLevels = new double[WalkSize, WalkSize];
    private readonly double[,] _vertexLevels = new double[WalkSize + 1, WalkSize + 1];
    private readonly double[,] _vertexHeights = new double[WalkSize + 1, WalkSize + 1];
    private readonly double _vertexOriginOffset = WalkSize / 2.0;

    public event EventHandler<WorldTickEventArgs>? WorldTicked;

    public GameWorld(GameWorldOptions? options = null)
    {
        _options = options ?? new GameWorldOptions();
        _environmentManager = new EnvironmentManager(_options);
        _mobManager = new MobManager(_options);
        InitializeTerrainHeightMaps();
        var abilityDefinitions = new[]
        {
            new AbilityDefinition
            {
                Id = "swordSweep",
                Name = "Sword Sweep",
                Key = "Weapon",
                Description = "Wide melee arc that cleaves enemies around you.",
                CooldownSeconds = 1.5,
                DamageMultiplier = 1.0,
                UnlockLevel = 1,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = true,
                AutoCast = true,
                Priority = 1.0,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Sweep,
                    Range = 4.2,
                    Radius = 4.0,
                    Speed = 0,
                    LifetimeSeconds = 0.6,
                    WindupSeconds = 0.15,
                    HitsMultipleTargets = true,
                    RequiresTarget = false,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "arrowStrike",
                Name = "Arrow Strike",
                Key = "Weapon",
                Description = "Rapid piercing arrow that travels in a straight line.",
                CooldownSeconds = 1.8,
                DamageMultiplier = 0.95,
                UnlockLevel = 1,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = true,
                AutoCast = true,
                Priority = 0.9,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 22,
                    Radius = 1.2,
                    Speed = 28,
                    LifetimeSeconds = 1.4,
                    WindupSeconds = 0.1,
                    HitsMultipleTargets = true,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "fireball",
                Name = "Fireball",
                Key = "Weapon",
                Description = "Launches an explosive orb that erupts on impact.",
                CooldownSeconds = 3.8,
                DamageMultiplier = 1.4,
                UnlockLevel = 2,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 1.4,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 18,
                    Radius = 3.5,
                    Speed = 16,
                    LifetimeSeconds = 2.5,
                    WindupSeconds = 0.25,
                    HitsMultipleTargets = true,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "shadowDaggers",
                Name = "Shadow Daggers",
                Key = "Weapon",
                Description = "A flurry of quick dagger strikes at close range.",
                CooldownSeconds = 0.7,
                DamageMultiplier = 0.6,
                UnlockLevel = 2,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = true,
                AutoCast = true,
                Priority = 0.6,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Melee,
                    Range = 2.6,
                    Radius = 1.2,
                    Speed = 0,
                    LifetimeSeconds = 0.35,
                    WindupSeconds = 0.05,
                    HitsMultipleTargets = false,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "stormChaser",
                Name = "Storm Chaser",
                Key = "Weapon",
                Description = "A crackling bolt that chains through clustered foes.",
                CooldownSeconds = 2.6,
                DamageMultiplier = 1.1,
                UnlockLevel = 3,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 1.2,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 16,
                    Radius = 2.2,
                    Speed = 24,
                    LifetimeSeconds = 1.6,
                    WindupSeconds = 0.18,
                    HitsMultipleTargets = true,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "frostNova",
                Name = "Frost Nova",
                Key = "Weapon",
                Description = "Unleashes a chilling burst that freezes the battlefield.",
                CooldownSeconds = 6.0,
                DamageMultiplier = 1.3,
                UnlockLevel = 3,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 1.6,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Sweep,
                    Range = 3.5,
                    Radius = 5.5,
                    Speed = 0,
                    LifetimeSeconds = 1.2,
                    WindupSeconds = 0.3,
                    HitsMultipleTargets = true,
                    RequiresTarget = false,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "earthshatter",
                Name = "Earthshatter",
                Key = "Weapon",
                Description = "Slams the ground and sends a crushing shockwave outward.",
                CooldownSeconds = 7.5,
                DamageMultiplier = 1.7,
                UnlockLevel = 4,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 1.8,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Sweep,
                    Range = 6.5,
                    Radius = 6.0,
                    Speed = 0,
                    LifetimeSeconds = 1.4,
                    WindupSeconds = 0.4,
                    HitsMultipleTargets = true,
                    RequiresTarget = false,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "windBlade",
                Name = "Wind Blade",
                Key = "Weapon",
                Description = "Launches a slicing gust that cuts distant foes.",
                CooldownSeconds = 2.2,
                DamageMultiplier = 1.0,
                UnlockLevel = 4,
                ResetOnLevelUp = false,
                ScalesWithAttackSpeed = true,
                AutoCast = true,
                Priority = 1.1,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 24,
                    Radius = 1.6,
                    Speed = 30,
                    LifetimeSeconds = 1.5,
                    WindupSeconds = 0.12,
                    HitsMultipleTargets = false,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "arcaneOrbit",
                Name = "Arcane Orbit",
                Key = "Weapon",
                Description = "Summons orbiting shards that sweep around you.",
                CooldownSeconds = 5.0,
                DamageMultiplier = 1.2,
                UnlockLevel = 5,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 1.5,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Sweep,
                    Range = 4.0,
                    Radius = 4.5,
                    Speed = 0,
                    LifetimeSeconds = 2.4,
                    WindupSeconds = 0.2,
                    HitsMultipleTargets = true,
                    RequiresTarget = false,
                    CanHitEnvironment = true
                }
            },
            new AbilityDefinition
            {
                Id = "voidLance",
                Name = "Void Lance",
                Key = "Weapon",
                Description = "Fires a focused beam that pierces through everything in its path.",
                CooldownSeconds = 7.0,
                DamageMultiplier = 2.0,
                UnlockLevel = 6,
                ResetOnLevelUp = true,
                ScalesWithAttackSpeed = false,
                AutoCast = true,
                Priority = 2.0,
                Attack = new AttackDescriptor
                {
                    Behavior = AttackBehavior.Projectile,
                    Range = 26,
                    Radius = 2.0,
                    Speed = 32,
                    LifetimeSeconds = 1.8,
                    WindupSeconds = 0.22,
                    HitsMultipleTargets = true,
                    RequiresTarget = true,
                    CanHitEnvironment = true
                }
            }
        };

        _abilityDefinitions = abilityDefinitions
            .OrderBy(a => a.UnlockLevel)
            .ThenBy(a => a.Priority)
            .ThenBy(a => a.Name)
            .ToArray();

        _abilityDefinitionMap = _abilityDefinitions.ToDictionary(a => a.Id, StringComparer.OrdinalIgnoreCase);

        _worldTimer = new Timer(WorldTick, null, TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(100));
    }

    public IReadOnlyDictionary<string, PlayerState> Players => _players;

    public AbilityDefinition[] AbilityDefinitions => _abilityDefinitions;

    public IReadOnlyList<PlayerStatUpgradeOption> StatUpgradeDefinitions => StatUpgradeOptions;

    public GameWorldOptions Options => _options;

    private void InitializeDefaultLoadoutLocked(PlayerState state, DateTime now)
    {
        if (state.WeaponLoadout.Count > 0)
        {
            return;
        }

        if (_abilityDefinitionMap.TryGetValue("swordSweep", out var defaultWeapon))
        {
            EquipWeaponLocked(state, defaultWeapon, now, preferredSlot: 1);
        }
    }

    public PlayerState AddPlayer(string connectionId)
    {
        var spawnX = 0.0;
        var spawnZ = 0.0;
        var groundY = SampleTerrainHeight(spawnX, spawnZ);
        var playerState = new PlayerState(connectionId, $"Explorer-{connectionId[..Math.Min(8, connectionId.Length)]}", spawnX, groundY + PlayerHeightOffset, spawnZ)
        {
            Heading = 0,
            VelocityX = 0,
            VelocityZ = 0,
            LastUpdate = DateTime.UtcNow
        };

        lock (playerState)
        {
            InitializeDefaultLoadoutLocked(playerState, DateTime.UtcNow);
            playerState.IsEthereal = false;
            playerState.PendingStatChoices.Clear();
        }

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
            state.IsEthereal = state.Stats.UnspentStatPoints > 0 || state.PendingWeaponChoices.Count > 0;
            return new PlayerStatsDto
            {
                Level = state.Stats.Level,
                Experience = state.Stats.Experience,
                ExperienceToNext = state.Stats.ExperienceToNext,
                Attack = state.Stats.Attack,
                MaxHealth = state.Stats.MaxHealth,
                CurrentHealth = state.Stats.CurrentHealth,
                AttackSpeed = state.Stats.AttackSpeed,
                MoveSpeed = state.Stats.MoveSpeed,
                UnspentStatPoints = state.Stats.UnspentStatPoints,
                IsEthereal = state.IsEthereal
            };
        }
    }

    public List<AbilityDto> BuildAbilitySnapshots(PlayerState state)
    {
        lock (state)
        {
            return BuildAbilitySnapshotsLocked(state, leveledUp: false, DateTime.UtcNow);
        }
    }

    public List<WeaponChoiceOption>? BuildWeaponChoices(PlayerState state)
    {
        lock (state)
        {
            return BuildWeaponChoiceOptionsLocked(state);
        }
    }

    public List<PlayerStatUpgradeOption>? BuildStatUpgradeOptions(PlayerState state)
    {
        lock (state)
        {
            return BuildStatUpgradeOptionsLocked(state);
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

        lock (state)
        {
            var now = DateTime.UtcNow;
            var previousX = state.X;
            var previousZ = state.Z;
            var previousUpdate = state.LastUpdate;
            var currentGround = SampleTerrainHeight(previousX, previousZ);

            var targetX = x;
            var targetZ = z;

            var dx = targetX - previousX;
            var dz = targetZ - previousZ;
            var distanceSq = dx * dx + dz * dz;
            if (distanceSq > _options.MaxMoveDistanceSquared)
            {
                var distance = Math.Sqrt(distanceSq);
                if (distance > 0)
                {
                    var scale = Math.Sqrt(_options.MaxMoveDistanceSquared) / distance;
                    targetX = previousX + dx * scale;
                    targetZ = previousZ + dz * scale;
                }
                else
                {
                    targetX = previousX;
                    targetZ = previousZ;
                }
            }

            var targetGround = SampleTerrainHeight(targetX, targetZ);
            if (Math.Abs(targetGround - currentGround) > MaxTerrainStepHeight)
            {
                var resolved = ResolveTerrainStep(previousX, previousZ, targetX, targetZ, currentGround);
                targetX = resolved.X;
                targetZ = resolved.Z;
                targetGround = resolved.GroundHeight;
            }

            var maxHeight = targetGround + 60.0;
            var minHeight = targetGround - 20.0;
            var adjustedY = Math.Clamp(y, minHeight, maxHeight);
            var minimumSupported = targetGround + PlayerHeightOffset;
            if (adjustedY < minimumSupported)
            {
                adjustedY = minimumSupported;
            }

            state.X = targetX;
            state.Y = adjustedY;
            state.Z = targetZ;
            state.Heading = NormalizeAngle(heading);

            var elapsedSeconds = (now - previousUpdate).TotalSeconds;
            if (elapsedSeconds > 1e-6)
            {
                var actualVelX = (state.X - previousX) / elapsedSeconds;
                var actualVelZ = (state.Z - previousZ) / elapsedSeconds;
                state.VelocityX = double.IsFinite(actualVelX) ? actualVelX : 0;
                state.VelocityZ = double.IsFinite(actualVelZ) ? actualVelZ : 0;
            }
            else
            {
                state.VelocityX = double.IsFinite(velocityX) ? velocityX : 0;
                state.VelocityZ = double.IsFinite(velocityZ) ? velocityZ : 0;
            }

            state.LastUpdate = now;
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

        if (playerState.IsEthereal)
        {
            return new AbilityExecutionResult(abilityId, targetId);
        }

        if (!_abilityDefinitionMap.TryGetValue(abilityId, out var abilityDefinition))
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
        List<WeaponChoiceOption>? weaponChoices;

        lock (player)
        {
            var abilityState = GetOrCreateAbilityState(player, abilityDefinition.Id, now);

            var stats = player.Stats;
            var equipped = player.WeaponLoadout.Values.Any(id =>
                string.Equals(id, abilityDefinition.Id, StringComparison.OrdinalIgnoreCase));
            abilityState.Unlocked = equipped;

            var descriptor = abilityDefinition.Attack;
            var originX = player.X;
            var originY = player.Y;
            var originZ = player.Z;
            var heading = player.Heading;

            if (equipped && abilityState.CooldownUntil <= now)
            {
                var cooldown = abilityDefinition.CooldownSeconds;
                if (abilityDefinition.ScalesWithAttackSpeed)
                {
                    var speed = Math.Max(0.1, stats.AttackSpeed);
                    cooldown = cooldown / speed;
                }

                cooldown = Math.Max(0.2, cooldown);
                var plannedDamage = Math.Max(1.0, stats.Attack * abilityDefinition.DamageMultiplier);

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
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                MoveSpeed = stats.MoveSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                IsEthereal = player.IsEthereal
            };

            abilitySnapshots = BuildAbilitySnapshotsLocked(player, leveledUp: false, now);
            weaponChoices = BuildWeaponChoiceOptionsLocked(player);
            upgradeOptions = BuildStatUpgradeOptionsLocked(player);
        }

        var result = new AbilityExecutionResult(abilityDefinition.Id, targetId);
        result.PlayerUpdates.Add(new PlayerStatsUpdate(player, statsSnapshot, 0, false, null, abilitySnapshots, upgradeOptions, weaponChoices));

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
        List<WeaponChoiceOption>? weaponChoices;
        var message = reason;

        lock (state)
        {
            var stats = state.Stats;
            stats.Experience += xpAwarded;
            leveledUp = false;
            var weaponMilestoneReached = false;

            while (stats.Experience >= stats.ExperienceToNext)
            {
                stats.Experience -= stats.ExperienceToNext;
                stats.Level++;
                leveledUp = true;

                var hasOpenSlot = state.WeaponLoadout.Count < MaxWeaponSlots;
                if (stats.Level % 5 == 0 && hasOpenSlot)
                {
                    weaponMilestoneReached = true;
                }
                else
                {
                    stats.UnspentStatPoints++;
                }

                stats.ExperienceToNext = CalculateExperienceForNext(stats.Level);
            }

            if (leveledUp)
            {
                stats.CurrentHealth = stats.MaxHealth;
                state.PendingStatChoices.Clear();
            }

            snapshot = new PlayerStatsDto
            {
                Level = stats.Level,
                Experience = stats.Experience,
                ExperienceToNext = stats.ExperienceToNext,
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                MoveSpeed = stats.MoveSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                IsEthereal = state.IsEthereal
            };

            abilities = BuildAbilitySnapshotsLocked(state, leveledUp, now);
            weaponChoices = weaponMilestoneReached
                ? PrepareWeaponChoicesLocked(state)
                : BuildWeaponChoiceOptionsLocked(state);
            upgradeOptions = BuildStatUpgradeOptionsLocked(state);

            state.IsEthereal = stats.UnspentStatPoints > 0 || (weaponChoices?.Count > 0);
            snapshot.IsEthereal = state.IsEthereal;

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

            if (weaponMilestoneReached && weaponChoices is { Count: > 0 })
            {
                const string weaponPrompt = "Select a new weapon.";
                if (string.IsNullOrWhiteSpace(message))
                {
                    message = weaponPrompt;
                }
                else if (!message.Contains(weaponPrompt, StringComparison.OrdinalIgnoreCase))
                {
                    message = $"{message} {weaponPrompt}";
                }
            }
        }

        return new PlayerStatsUpdate(state, snapshot, xpAwarded, leveledUp, message, abilities, upgradeOptions, weaponChoices);
    }

    public PlayerStatsUpdate? ChooseWeapon(string playerId, string abilityId, DateTime now)
    {
        if (!TryGetPlayer(playerId, out var playerState) || playerState is null)
        {
            return null;
        }

        lock (playerState)
        {
            var pendingChoice = playerState.PendingWeaponChoices.Any(id =>
                string.Equals(id, abilityId, StringComparison.OrdinalIgnoreCase));

            if (!pendingChoice)
            {
                return null;
            }

            if (!_abilityDefinitionMap.TryGetValue(abilityId, out var definition))
            {
                playerState.PendingWeaponChoices.Clear();
                return null;
            }

            var (slot, replacedId) = EquipWeaponLocked(playerState, definition, now);
            playerState.PendingWeaponChoices.Clear();

            var stats = playerState.Stats;
            var snapshot = new PlayerStatsDto
            {
                Level = stats.Level,
                Experience = stats.Experience,
                ExperienceToNext = stats.ExperienceToNext,
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                MoveSpeed = stats.MoveSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                IsEthereal = playerState.IsEthereal
            };

            var abilities = BuildAbilitySnapshotsLocked(playerState, leveledUp: false, now);
            var upgradeOptions = BuildStatUpgradeOptionsLocked(playerState);
            var weaponChoices = BuildWeaponChoiceOptionsLocked(playerState);

            playerState.IsEthereal = stats.UnspentStatPoints > 0 || (weaponChoices?.Count > 0);
            snapshot.IsEthereal = playerState.IsEthereal;

            string message;
            if (!string.IsNullOrWhiteSpace(replacedId))
            {
                var replacedName = GetAbilityDisplayName(replacedId);
                message = $"Equipped {definition.Name} in slot {slot}, replacing {replacedName}.";
            }
            else
            {
                message = $"Equipped {definition.Name} in slot {slot}.";
            }

            return new PlayerStatsUpdate(playerState, snapshot, 0, false, message, abilities, upgradeOptions, weaponChoices);
        }
    }

    private PlayerAbilityState GetOrCreateAbilityState(PlayerState state, string abilityId, DateTime now)
    {
        if (!state.Abilities.TryGetValue(abilityId, out var abilityState))
        {
            abilityState = new PlayerAbilityState
            {
                AbilityId = abilityId,
                CooldownUntil = now,
                Unlocked = false,
                WeaponSlot = null
            };

            state.Abilities[abilityId] = abilityState;
        }

        return abilityState;
    }

    private (int Slot, string? ReplacedAbilityId) EquipWeaponLocked(PlayerState state, AbilityDefinition definition, DateTime now, int? preferredSlot = null)
    {
        var targetSlot = ResolveTargetSlot(state, definition.Id, preferredSlot);
        string? replaced = null;

        if (state.WeaponLoadout.TryGetValue(targetSlot, out var existingId))
        {
            if (!string.Equals(existingId, definition.Id, StringComparison.OrdinalIgnoreCase))
            {
                replaced = existingId;
                if (state.Abilities.TryGetValue(existingId, out var existingState))
                {
                    existingState.Unlocked = false;
                    existingState.WeaponSlot = null;
                    existingState.CooldownUntil = now;
                }
            }
        }

        var duplicates = state.WeaponLoadout
            .Where(kv => kv.Key != targetSlot && string.Equals(kv.Value, definition.Id, StringComparison.OrdinalIgnoreCase))
            .Select(kv => kv.Key)
            .ToList();

        foreach (var slot in duplicates)
        {
            state.WeaponLoadout.Remove(slot);
        }

        state.WeaponLoadout[targetSlot] = definition.Id;

        var abilityState = GetOrCreateAbilityState(state, definition.Id, now);
        abilityState.Unlocked = true;
        abilityState.WeaponSlot = targetSlot;
        abilityState.CooldownUntil = now;

        return (targetSlot, replaced);
    }

    private static int ResolveTargetSlot(PlayerState state, string abilityId, int? preferredSlot)
    {
        if (preferredSlot is >= 1 and <= MaxWeaponSlots)
        {
            return preferredSlot.Value;
        }

        foreach (var kvp in state.WeaponLoadout)
        {
            if (string.Equals(kvp.Value, abilityId, StringComparison.OrdinalIgnoreCase))
            {
                return kvp.Key;
            }
        }

        for (var slot = 1; slot <= MaxWeaponSlots; slot++)
        {
            if (!state.WeaponLoadout.ContainsKey(slot))
            {
                return slot;
            }
        }

        return MaxWeaponSlots;
    }

    private string GetAbilityDisplayName(string abilityId)
    {
        return _abilityDefinitionMap.TryGetValue(abilityId, out var definition)
            ? definition.Name
            : abilityId;
    }

    private List<WeaponChoiceOption>? PrepareWeaponChoicesLocked(PlayerState state)
    {
        var eligible = _abilityDefinitions
            .Where(definition => definition.UnlockLevel <= state.Stats.Level)
            .ToList();

        if (eligible.Count == 0)
        {
            state.PendingWeaponChoices.Clear();
            return null;
        }

        var owned = new HashSet<string>(state.WeaponLoadout.Values, StringComparer.OrdinalIgnoreCase);
        var pool = eligible.Where(definition => !owned.Contains(definition.Id)).ToList();

        if (pool.Count < 3)
        {
            pool = eligible;
        }

        if (pool.Count == 0)
        {
            state.PendingWeaponChoices.Clear();
            return null;
        }

        state.PendingWeaponChoices.Clear();

        var workingPool = new List<AbilityDefinition>(pool);
        while (state.PendingWeaponChoices.Count < Math.Min(3, workingPool.Count) && workingPool.Count > 0)
        {
            var index = Random.Shared.Next(workingPool.Count);
            var pick = workingPool[index];
            state.PendingWeaponChoices.Add(pick.Id);
            workingPool.RemoveAt(index);
        }

        return BuildWeaponChoiceOptionsLocked(state);
    }

    private List<WeaponChoiceOption>? BuildWeaponChoiceOptionsLocked(PlayerState state)
    {
        if (state.PendingWeaponChoices.Count == 0)
        {
            return null;
        }

        var list = new List<WeaponChoiceOption>();
        foreach (var abilityId in state.PendingWeaponChoices)
        {
            if (_abilityDefinitionMap.TryGetValue(abilityId, out var definition))
            {
                list.Add(new WeaponChoiceOption
                {
                    Id = definition.Id,
                    Name = definition.Name,
                    Description = definition.Description,
                    UnlockLevel = definition.UnlockLevel
                });
            }
        }

        return list.Count > 0 ? list : null;
    }

    private List<PlayerStatUpgradeOption>? BuildStatUpgradeOptionsLocked(PlayerState state)
    {
        if (state.Stats.UnspentStatPoints <= 0)
        {
            state.PendingStatChoices.Clear();
            return null;
        }

        if (state.PendingStatChoices.Count == 0)
        {
            var pool = new List<PlayerStatUpgradeOption>(StatUpgradeOptions);
            Shuffle(pool);
            var pickCount = Math.Min(3, pool.Count);
            for (var i = 0; i < pickCount; i++)
            {
                state.PendingStatChoices.Add(pool[i].Id);
            }
        }

        var options = new List<PlayerStatUpgradeOption>(state.PendingStatChoices.Count);
        foreach (var id in state.PendingStatChoices)
        {
            if (StatUpgradeMap.TryGetValue(id, out var option))
            {
                options.Add(option);
            }
        }

        return options.Count > 0 ? options : null;
    }

    private static void Shuffle<T>(IList<T> list)
    {
        for (var i = list.Count - 1; i > 0; i--)
        {
            var j = Random.Shared.Next(i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }
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

    public PlayerStatsUpdate? ApplyStatUpgrade(PlayerState state, string statId, DateTime now)
    {
        PlayerStatsDto snapshot;
        List<AbilityDto> abilities;
        List<PlayerStatUpgradeOption>? upgradeOptions;
        List<WeaponChoiceOption>? weaponChoices;
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

            state.PendingStatChoices.Clear();

            snapshot = new PlayerStatsDto
            {
                Level = stats.Level,
                Experience = stats.Experience,
                ExperienceToNext = stats.ExperienceToNext,
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                MoveSpeed = stats.MoveSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                IsEthereal = state.IsEthereal
            };

            abilities = BuildAbilitySnapshotsLocked(state, leveledUp: false, now);
            upgradeOptions = BuildStatUpgradeOptionsLocked(state);
            weaponChoices = BuildWeaponChoiceOptionsLocked(state);

            state.IsEthereal = stats.UnspentStatPoints > 0 || (weaponChoices?.Count > 0);
            snapshot.IsEthereal = state.IsEthereal;
        }

        return new PlayerStatsUpdate(state, snapshot, 0, false, message, abilities, upgradeOptions, weaponChoices);
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
            case "attack":
                stats.Attack += 2;
                message = "Attack increased!";
                break;
            case "maxhealth":
            case "health":
                stats.MaxHealth += 10;
                stats.CurrentHealth = stats.MaxHealth;
                message = "Max health increased!";
                break;
            case "attackspeed":
            case "speed":
                stats.AttackSpeed = Math.Round(Math.Max(0.1, stats.AttackSpeed + 0.1), 2, MidpointRounding.AwayFromZero);
                message = "Attack speed improved!";
                break;
            case "movespeed":
            case "swiftness":
                stats.MoveSpeed = Math.Round(stats.MoveSpeed + 1.0, 2, MidpointRounding.AwayFromZero);
                message = "Move speed increased!";
                break;
            default:
                return false;
        }

        stats.UnspentStatPoints = Math.Max(0, stats.UnspentStatPoints - 1);

        return true;
    }

    public PlayerRespawnUpdate HandlePlayerDefeat(PlayerState state, string mobName, DateTime now)
    {
        PlayerStatsDto snapshot;
        List<AbilityDto> abilities;
        List<PlayerStatUpgradeOption>? upgradeOptions;

        var spawnX = 0.0;
        var spawnZ = 0.0;
        var spawnY = SampleTerrainHeight(spawnX, spawnZ) + PlayerHeightOffset;

        List<WeaponChoiceOption>? weaponChoices;

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
                Attack = state.Stats.Attack,
                MaxHealth = state.Stats.MaxHealth,
                CurrentHealth = state.Stats.CurrentHealth,
                AttackSpeed = state.Stats.AttackSpeed,
                MoveSpeed = state.Stats.MoveSpeed,
                UnspentStatPoints = state.Stats.UnspentStatPoints,
                IsEthereal = state.IsEthereal
            };

            abilities = BuildAbilitySnapshotsLocked(state, leveledUp: false, now);
            upgradeOptions = BuildStatUpgradeOptionsLocked(state);
            weaponChoices = BuildWeaponChoiceOptionsLocked(state);

            state.IsEthereal = state.Stats.UnspentStatPoints > 0 || (weaponChoices?.Count > 0);
            snapshot.IsEthereal = state.IsEthereal;
        }

        var playerSnapshot = CreatePlayerSnapshot(state);
        var statsUpdate = new PlayerStatsUpdate(state, snapshot, 0, false, $"You were defeated by {mobName}.", abilities, upgradeOptions, weaponChoices);
        return new PlayerRespawnUpdate(playerSnapshot, statsUpdate);
    }

    public PlayerDamageResult ProcessMobDamage(PlayerState state, double damage, string mobName, DateTime now)
    {
        PlayerStatsDto snapshot;
        bool defeated;
        string? reason;
        List<PlayerStatUpgradeOption>? upgradeOptions;
        List<WeaponChoiceOption>? weaponChoices;

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
                Attack = stats.Attack,
                MaxHealth = stats.MaxHealth,
                CurrentHealth = stats.CurrentHealth,
                AttackSpeed = stats.AttackSpeed,
                MoveSpeed = stats.MoveSpeed,
                UnspentStatPoints = stats.UnspentStatPoints,
                IsEthereal = state.IsEthereal
            };

            reason = defeated ? null : $"{mobName} hit you for {appliedDamage}.";
            upgradeOptions = BuildStatUpgradeOptionsLocked(state);
            weaponChoices = BuildWeaponChoiceOptionsLocked(state);

            state.IsEthereal = stats.UnspentStatPoints > 0 || (weaponChoices?.Count > 0);
            snapshot.IsEthereal = state.IsEthereal;
        }

        var update = new PlayerStatsUpdate(state, snapshot, 0, false, reason, null, upgradeOptions, weaponChoices);
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
                bool isEthereal;
                lock (playerState)
                {
                    isEthereal = playerState.IsEthereal;
                }

                if (!isEthereal)
                {
                    var damageResult = ProcessMobDamage(playerState, attack.Damage, attack.MobName, now);
                    eventArgs.PlayerStatUpdates.Add(damageResult.Update);

                    if (damageResult.Defeated)
                    {
                        var respawn = HandlePlayerDefeat(playerState, attack.MobName, now);
                        eventArgs.PlayerRespawns.Add(respawn);
                    }
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
                    state.Stats.CurrentHealth,
                    state.IsEthereal);
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
                var mobBlueprint = new MobBlueprint
                {
                    Id = $"mob-{cx}-{cz}-{i}",
                    ChunkX = cx,
                    ChunkZ = cz,
                    Type = "runicHunter",
                    Name = rng.NextDouble() < 0.5 ? "Runic Hunter" : "Prism Stalker",
                    X = worldX,
                    Y = worldY,
                    Z = worldZ
                };

                mobBlueprints.Add(mobBlueprint);
                _mobManager.EnsureBlueprint(mobBlueprint);
            }
        }

        return (environmentBlueprints, mobBlueprints);
    }

    private static int CalculateExperienceForNext(int level)
    {
        return 80 + Math.Max(0, level - 1) * 35;
    }

    private List<AbilityDto> BuildAbilitySnapshotsLocked(PlayerState state, bool leveledUp, DateTime now)
    {
        var list = new List<AbilityDto>(MaxWeaponSlots);
        var equippedIds = new HashSet<string>(state.WeaponLoadout.Values, StringComparer.OrdinalIgnoreCase);

        foreach (var kvp in state.WeaponLoadout.OrderBy(entry => entry.Key))
        {
            var slot = kvp.Key;
            if (slot < 1 || slot > MaxWeaponSlots)
            {
                continue;
            }

            if (!_abilityDefinitionMap.TryGetValue(kvp.Value, out var definition))
            {
                continue;
            }

            var abilityState = GetOrCreateAbilityState(state, definition.Id, now);
            if (leveledUp && definition.ResetOnLevelUp)
            {
                abilityState.CooldownUntil = now;
            }

            abilityState.Unlocked = true;
            abilityState.WeaponSlot = slot;

            var cooldownRemaining = Math.Max(0, (abilityState.CooldownUntil - now).TotalSeconds);

            list.Add(new AbilityDto
            {
                AbilityId = definition.Id,
                Name = definition.Name,
                Key = $"Slot {slot}",
                CooldownSeconds = cooldownRemaining,
                Unlocked = true,
                Available = cooldownRemaining <= 0,
                ResetOnLevelUp = definition.ResetOnLevelUp,
                Range = definition.Attack?.Range ?? 6,
                AutoCast = definition.AutoCast,
                Priority = definition.Priority,
                WeaponSlot = slot
            });
        }

        foreach (var kv in state.Abilities)
        {
            var abilityState = kv.Value;
            var isEquipped = equippedIds.Contains(kv.Key);
            abilityState.Unlocked = isEquipped;
            if (!isEquipped)
            {
                abilityState.WeaponSlot = null;
            }
        }

        return list;
    }

    private void InitializeTerrainHeightMaps()
    {
        var coords = new List<(int X, int Z)>(WalkSize * WalkSize);
        for (var z = 0; z < WalkSize; z++)
        {
            if (z % 2 == 0)
            {
                for (var x = 0; x < WalkSize; x++)
                {
                    coords.Add((x, z));
                }
            }
            else
            {
                for (var x = WalkSize - 1; x >= 0; x--)
                {
                    coords.Add((x, z));
                }
            }
        }

        var rng = new Random(_options.WorldSeed);
        var current = 0;

        Span<int> candidates = stackalloc int[3];
        for (var index = 0; index < coords.Count; index++)
        {
            var (x, z) = coords[index];
            _cellLevels[z, x] = current;

            if (index == coords.Count - 1)
            {
                break;
            }

            var candidateCount = 0;
            for (var delta = -1; delta <= 1; delta++)
            {
                var next = current + delta;
                if (next >= MinWalkDepth && next <= MaxWalkDepth)
                {
                    candidates[candidateCount++] = next;
                }
            }

            if (candidateCount > 0)
            {
                var pickIndex = rng.Next(candidateCount);
                current = candidates[pickIndex];
            }
        }

        for (var vz = 0; vz <= WalkSize; vz++)
        {
            for (var vx = 0; vx <= WalkSize; vx++)
            {
                var samples = new List<double>(4);
                if (vx > 0 && vz > 0)
                {
                    samples.Add(_cellLevels[vz - 1, vx - 1]);
                }
                if (vx > 0 && vz < WalkSize)
                {
                    samples.Add(_cellLevels[vz, vx - 1]);
                }
                if (vx < WalkSize && vz > 0)
                {
                    samples.Add(_cellLevels[vz - 1, vx]);
                }
                if (vx < WalkSize && vz < WalkSize)
                {
                    samples.Add(_cellLevels[vz, vx]);
                }

                var average = samples.Count > 0 ? samples.Average() : 0;
                var quantized = Math.Clamp((int)Math.Round(average), MinWalkDepth, MaxWalkDepth);
                _vertexLevels[vz, vx] = quantized;
                _vertexHeights[vz, vx] = quantized * HeightStep;
            }
        }
    }

    public TerrainSnapshot BuildTerrainSnapshot()
    {
        var heights = new double[WalkSize + 1][];
        for (var z = 0; z <= WalkSize; z++)
        {
            heights[z] = new double[WalkSize + 1];
            for (var x = 0; x <= WalkSize; x++)
            {
                heights[z][x] = _vertexHeights[z, x];
            }
        }

        return new TerrainSnapshot
        {
            WalkSize = WalkSize,
            TileSize = TileSize,
            HeightStep = HeightStep,
            MinDepth = MinWalkDepth,
            MaxDepth = MaxWalkDepth,
            VertexHeights = heights
        };
    }

    private double SampleTerrainHeight(double x, double z)
    {
        var gridX = x / TileSize + _vertexOriginOffset;
        var gridZ = z / TileSize + _vertexOriginOffset;

        if (gridX < 0 || gridX > WalkSize || gridZ < 0 || gridZ > WalkSize)
        {
            return 0.0;
        }

        const double epsilon = 1e-6;
        var clampedX = Math.Clamp(gridX, 0, WalkSize - epsilon);
        var clampedZ = Math.Clamp(gridZ, 0, WalkSize - epsilon);
        var ix = (int)Math.Floor(clampedX);
        var iz = (int)Math.Floor(clampedZ);
        var fx = clampedX - ix;
        var fz = clampedZ - iz;

        var h00 = _vertexHeights[iz, ix];
        var h10 = _vertexHeights[iz, ix + 1];
        var h01 = _vertexHeights[iz + 1, ix];
        var h11 = _vertexHeights[iz + 1, ix + 1];

        var north = h00 * (1 - fx) + h10 * fx;
        var south = h01 * (1 - fx) + h11 * fx;
        return north * (1 - fz) + south * fz;
    }

    private (double X, double Z, double GroundHeight) ResolveTerrainStep(double currentX, double currentZ, double targetX, double targetZ, double currentGround)
    {
        var dx = targetX - currentX;
        var dz = targetZ - currentZ;
        var distance = Math.Sqrt(dx * dx + dz * dz);
        if (distance <= 1e-6)
        {
            return (currentX, currentZ, currentGround);
        }

        var low = 0.0;
        var high = 1.0;
        var best = 0.0;
        for (var i = 0; i < 6; i++)
        {
            var mid = (low + high) * 0.5;
            var testX = currentX + dx * mid;
            var testZ = currentZ + dz * mid;
            var testGround = SampleTerrainHeight(testX, testZ);
            if (Math.Abs(testGround - currentGround) <= MaxTerrainStepHeight)
            {
                best = mid;
                low = mid;
            }
            else
            {
                high = mid;
            }
        }

        if (best <= 1e-3)
        {
            return (currentX, currentZ, currentGround);
        }

        var finalX = currentX + dx * best;
        var finalZ = currentZ + dz * best;
        var finalGround = SampleTerrainHeight(finalX, finalZ);
        if (Math.Abs(finalGround - currentGround) > MaxTerrainStepHeight + 0.01)
        {
            return (currentX, currentZ, currentGround);
        }

        return (finalX, finalZ, finalGround);
    }

    private static double NormalizeAngle(double angle)
    {
        if (!double.IsFinite(angle))
        {
            return 0;
        }

        const double twoPi = Math.PI * 2;
        var normalized = angle % twoPi;
        if (normalized <= -Math.PI)
        {
            normalized += twoPi;
        }
        else if (normalized > Math.PI)
        {
            normalized -= twoPi;
        }

        return normalized;
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
        IReadOnlyList<PlayerStatUpgradeOption>? upgradeOptions,
        IReadOnlyList<WeaponChoiceOption>? weaponChoices)
    {
        Player = player;
        Snapshot = snapshot;
        ExperienceAwarded = experienceAwarded;
        LeveledUp = leveledUp;
        Reason = reason;
        Abilities = abilities;
        UpgradeOptions = upgradeOptions;
        WeaponChoices = weaponChoices;
    }

    public PlayerState Player { get; }
    public PlayerStatsDto Snapshot { get; }
    public int ExperienceAwarded { get; }
    public bool LeveledUp { get; }
    public string? Reason { get; }
    public IReadOnlyList<AbilityDto>? Abilities { get; }
    public IReadOnlyList<PlayerStatUpgradeOption>? UpgradeOptions { get; }
    public IReadOnlyList<WeaponChoiceOption>? WeaponChoices { get; }
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
