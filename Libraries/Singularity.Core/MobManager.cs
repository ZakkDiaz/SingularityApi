using System.Collections.Concurrent;

namespace Singularity.Core;

public sealed class MobManager
{
    private readonly GameWorldOptions _options;
    private readonly ConcurrentDictionary<string, MobBlueprint> _blueprints = new();
    private readonly ConcurrentDictionary<string, MobRuntimeState> _states = new();

    public MobManager(GameWorldOptions options)
    {
        _options = options;
    }

    public void EnsureBlueprint(MobBlueprint blueprint)
    {
        _blueprints.AddOrUpdate(blueprint.Id, blueprint, (_, existing) => existing);
        _states.AddOrUpdate(
            blueprint.Id,
            _ => new MobRuntimeState(blueprint, _options),
            (_, existing) =>
            {
                lock (existing)
                {
                    existing.Configure(blueprint, _options);
                    return existing;
                }
            });
    }

    public List<MobSnapshotDto> CreateSnapshotForChunk(ChunkData chunk)
    {
        var list = new List<MobSnapshotDto>(chunk.MobBlueprints.Count);

        foreach (var blueprint in chunk.MobBlueprints)
        {
            var snapshot = BuildSnapshot(blueprint.Id);
            if (snapshot != null)
            {
                list.Add(snapshot);
            }
        }

        return list;
    }

    public bool TryStrike(
        string mobId,
        double damage,
        string attackerId,
        out MobSnapshotDto? updated,
        out bool defeated,
        out string mobName)
    {
        updated = null;
        defeated = false;
        mobName = "Enemy";

        if (!_states.TryGetValue(mobId, out var state))
        {
            return false;
        }

        if (!_blueprints.TryGetValue(mobId, out var blueprint))
        {
            return false;
        }

        mobName = blueprint.Name;
        damage = Math.Max(1.0, damage);

        lock (state)
        {
            if (!state.IsAlive)
            {
                return false;
            }

            state.Health = Math.Max(0, state.Health - damage);
            state.TargetPlayerId = attackerId;

            if (state.Health <= double.Epsilon)
            {
                state.IsAlive = false;
                state.RespawnAt = DateTime.UtcNow.AddSeconds(_options.MobRespawnSeconds);
                state.TargetPlayerId = null;
                defeated = true;
            }
        }

        updated = BuildSnapshot(mobId);
        return true;
    }

    public MobTickResult Tick(TimeSpan delta, IReadOnlyDictionary<string, PlayerObservation> players, Func<double, double, double> sampleTerrainHeight)
    {
        var result = new MobTickResult();
        var now = DateTime.UtcNow;
        var deltaSeconds = Math.Clamp(delta.TotalSeconds, 0.01, 0.5);

        foreach (var kvp in _states)
        {
            var mobId = kvp.Key;
            var state = kvp.Value;
            var changed = false;
            _blueprints.TryGetValue(mobId, out var mobBlueprint);

            lock (state)
            {
                if (!state.IsAlive)
                {
                    if (state.RespawnAt.HasValue && state.RespawnAt.Value <= now)
                    {
                        state.IsAlive = true;
                        state.RespawnAt = null;
                        state.Health = state.MaxHealth;
                        state.X = state.SpawnX;
                        state.Y = state.SpawnY;
                        state.Z = state.SpawnZ;
                        state.TargetPlayerId = null;
                        state.AttackCooldown = 0;
                        changed = true;
                    }
                }
                else
                {
                    state.AttackCooldown = Math.Max(0, state.AttackCooldown - deltaSeconds);

                    if (state.TargetPlayerId != null)
                    {
                        if (!players.TryGetValue(state.TargetPlayerId, out var existingTarget) || existingTarget.CurrentHealth <= 0)
                        {
                            state.TargetPlayerId = null;
                        }
                    }

                    if (state.TargetPlayerId == null)
                    {
                        var bestDistanceSq = _options.MobAggroRange * _options.MobAggroRange;
                        foreach (var observation in players.Values)
                        {
                            if (observation.CurrentHealth <= 0)
                            {
                                continue;
                            }

                            var dx = observation.X - state.X;
                            var dz = observation.Z - state.Z;
                            var distSq = dx * dx + dz * dz;
                            if (distSq < bestDistanceSq)
                            {
                                bestDistanceSq = distSq;
                                state.TargetPlayerId = observation.PlayerId;
                            }
                        }
                    }

                    PlayerObservation? targetObservation = null;
                    if (state.TargetPlayerId != null && players.TryGetValue(state.TargetPlayerId, out var obs))
                    {
                        targetObservation = obs;
                    }

                    if (targetObservation.HasValue)
                    {
                        var target = targetObservation.Value;
                        var dx = target.X - state.X;
                        var dz = target.Z - state.Z;
                        var distance = Math.Sqrt(dx * dx + dz * dz);

                        if (distance > 0.01)
                        {
                            var step = Math.Min(distance, _options.MobMoveSpeed * deltaSeconds);
                            state.X += dx / distance * step;
                            state.Z += dz / distance * step;
                            state.Heading = Math.Atan2(dx, dz);
                            state.Y = sampleTerrainHeight(state.X, state.Z) + state.HeightOffset;
                            changed = true;
                        }

                        if (distance > _options.MobAggroRange * 1.35)
                        {
                            state.TargetPlayerId = null;
                        }
                        else if (distance <= _options.MobAttackRange + 0.1 && state.AttackCooldown <= 0)
                        {
                            state.AttackCooldown = _options.MobAttackCooldown;
                            result.Attacks.Add(new MobAttackEvent
                            {
                                MobId = mobId,
                                PlayerId = target.PlayerId,
                                Damage = _options.MobAttackDamage,
                                MobName = mobBlueprint?.Name ?? "Enemy"
                            });
                            changed = true;
                        }
                    }
                    else
                    {
                        var dx = state.SpawnX - state.X;
                        var dz = state.SpawnZ - state.Z;
                        var distance = Math.Sqrt(dx * dx + dz * dz);
                        if (distance > 0.05)
                        {
                            var step = Math.Min(distance, _options.MobMoveSpeed * 0.6 * deltaSeconds);
                            state.X += dx / distance * step;
                            state.Z += dz / distance * step;
                            state.Heading = Math.Atan2(dx, dz);
                            state.Y = sampleTerrainHeight(state.X, state.Z) + state.HeightOffset;
                            changed = true;
                        }
                        else
                        {
                            state.X = state.SpawnX;
                            state.Y = state.SpawnY;
                            state.Z = state.SpawnZ;
                        }
                    }
                }
            }

            if (changed)
            {
                var snapshot = BuildSnapshot(mobId);
                if (snapshot != null)
                {
                    result.Updates.Add(snapshot);
                }
            }
        }

        return result;
    }

    public MobSnapshotDto? BuildSnapshot(string mobId)
    {
        if (!_states.TryGetValue(mobId, out var state))
        {
            return null;
        }

        _blueprints.TryGetValue(mobId, out var blueprint);

        lock (state)
        {
            var healthFraction = state.MaxHealth > 0
                ? Math.Clamp(state.Health / state.MaxHealth, 0, 1)
                : 0;

            return new MobSnapshotDto
            {
                Id = mobId,
                Type = blueprint?.Type ?? "mob",
                Name = blueprint?.Name ?? "Enemy",
                X = state.X,
                Y = state.Y,
                Z = state.Z,
                Heading = state.Heading,
                IsAlive = state.IsAlive,
                HealthFraction = healthFraction,
                TargetPlayerId = state.TargetPlayerId
            };
        }
    }

    private sealed class MobRuntimeState
    {
        public MobRuntimeState(MobBlueprint blueprint, GameWorldOptions options)
        {
            Configure(blueprint, options);
        }

        public bool IsAlive { get; set; } = true;
        public double X { get; set; }
        public double Y { get; set; }
        public double Z { get; set; }
        public double Heading { get; set; }
        public double SpawnX { get; set; }
        public double SpawnY { get; set; }
        public double SpawnZ { get; set; }
        public double HeightOffset { get; set; }
        public double Health { get; set; }
        public double MaxHealth { get; set; }
        public double AttackCooldown { get; set; }
        public string? TargetPlayerId { get; set; }
        public DateTime? RespawnAt { get; set; }

        public void Configure(MobBlueprint blueprint, GameWorldOptions options)
        {
            SpawnX = blueprint.X;
            SpawnY = blueprint.Y;
            SpawnZ = blueprint.Z;
            X = blueprint.X;
            Y = blueprint.Y;
            Z = blueprint.Z;
            Heading = 0;
            HeightOffset = 1.0;
            MaxHealth = options.MobBaseHealth;
            Health = MaxHealth;
            AttackCooldown = 0;
            TargetPlayerId = null;
            RespawnAt = null;
            IsAlive = true;
        }
    }
}

public sealed class MobTickResult
{
    public List<MobSnapshotDto> Updates { get; } = new();
    public List<MobAttackEvent> Attacks { get; } = new();
}

public sealed class MobAttackEvent
{
    public string MobId { get; set; } = string.Empty;
    public string PlayerId { get; set; } = string.Empty;
    public double Damage { get; set; }
    public string MobName { get; set; } = string.Empty;
}

public readonly struct PlayerObservation
{
    public PlayerObservation(string playerId, double x, double y, double z, int currentHealth)
    {
        PlayerId = playerId;
        X = x;
        Y = y;
        Z = z;
        CurrentHealth = currentHealth;
    }

    public string PlayerId { get; }
    public double X { get; }
    public double Y { get; }
    public double Z { get; }
    public int CurrentHealth { get; }
}
