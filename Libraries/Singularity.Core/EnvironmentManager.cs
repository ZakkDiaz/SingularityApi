using System.Collections.Concurrent;
using System.Collections.Generic;

namespace Singularity.Core;

public sealed class EnvironmentManager
{
    private readonly GameWorldOptions _options;
    private readonly ConcurrentDictionary<string, EnvironmentBlueprint> _blueprints = new();
    private readonly ConcurrentDictionary<string, EnvironmentRuntimeState> _states = new();

    public EnvironmentManager(GameWorldOptions options)
    {
        _options = options;
    }

    public void EnsureBlueprint(EnvironmentBlueprint blueprint)
    {
        _blueprints.AddOrUpdate(blueprint.Id, blueprint, (_, existing) => existing);
        _states.AddOrUpdate(
            blueprint.Id,
            _ =>
            {
                var runtime = new EnvironmentRuntimeState();
                runtime.ConfigureForBlueprint(blueprint, _options, resetState: true);
                return runtime;
            },
            (_, existing) =>
            {
                lock (existing)
                {
                    existing.ConfigureForBlueprint(blueprint, _options, resetState: false);
                    return existing;
                }
            });
    }

    public List<EnvironmentObjectDto> CreateSnapshotForChunk(ChunkData chunk)
    {
        var list = new List<EnvironmentObjectDto>(chunk.EnvironmentBlueprints.Count);
        foreach (var blueprint in chunk.EnvironmentBlueprints)
        {
            var snapshot = BuildSnapshot(blueprint.Id);
            if (snapshot != null)
            {
                list.Add(snapshot);
            }
        }

        return list;
    }

    public bool TryStrike(string environmentId, double damage, out EnvironmentObjectDto? updated, out bool defeated)
    {
        updated = null;
        defeated = false;

        if (!_blueprints.TryGetValue(environmentId, out var blueprint) ||
            !_states.TryGetValue(environmentId, out var state))
        {
            return false;
        }

        if (!string.Equals(blueprint.Type, "sentinel", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        damage = Math.Max(1.0, damage);

        lock (state)
        {
            if (!state.IsActive)
            {
                if (state.RespawnAt.HasValue && state.RespawnAt.Value > DateTime.UtcNow)
                {
                    return false;
                }

                state.IsActive = true;
                state.RespawnAt = null;
                state.Health = state.MaxHealth;
            }

            state.Health = Math.Max(0, state.Health - damage);

            if (state.Health <= double.Epsilon)
            {
                state.IsActive = false;
                state.RespawnAt = DateTime.UtcNow.AddSeconds(_options.SentinelRespawnSeconds);
                state.Health = 0;
                defeated = true;
            }
        }

        updated = BuildSnapshot(environmentId);
        return updated != null;
    }

    public bool TryGetTargetInfo(string environmentId, out EnvironmentTargetInfo info)
    {
        info = default;

        if (!_blueprints.TryGetValue(environmentId, out var blueprint) ||
            !_states.TryGetValue(environmentId, out var state))
        {
            return false;
        }

        var isSentinel = string.Equals(blueprint.Type, "sentinel", StringComparison.OrdinalIgnoreCase);

        lock (state)
        {
            info = new EnvironmentTargetInfo(
                blueprint.Id,
                blueprint.Type,
                blueprint.X,
                blueprint.Y,
                blueprint.Z,
                isSentinel && state.IsActive);
            return isSentinel;
        }
    }

    public List<EnvironmentTargetInfo> CollectTargetsInRange(double centerX, double centerZ, double radius)
    {
        var results = new List<EnvironmentTargetInfo>();
        var radiusSq = Math.Max(0, radius * radius);

        foreach (var kvp in _blueprints)
        {
            var blueprint = kvp.Value;
            if (!string.Equals(blueprint.Type, "sentinel", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!_states.TryGetValue(kvp.Key, out var state))
            {
                continue;
            }

            var dx = blueprint.X - centerX;
            var dz = blueprint.Z - centerZ;
            if (dx * dx + dz * dz > radiusSq)
            {
                continue;
            }

            lock (state)
            {
                if (!state.IsActive)
                {
                    continue;
                }

                results.Add(new EnvironmentTargetInfo(
                    blueprint.Id,
                    blueprint.Type,
                    blueprint.X,
                    blueprint.Y,
                    blueprint.Z,
                    true));
            }
        }

        return results;
    }

    public List<EnvironmentObjectDto> CollectRespawns()
    {
        var result = new List<EnvironmentObjectDto>();

        foreach (var kvp in _states)
        {
            var state = kvp.Value;
            var changed = false;

            lock (state)
            {
                if (!state.IsActive && state.RespawnAt.HasValue && state.RespawnAt.Value <= DateTime.UtcNow)
                {
                    state.IsActive = true;
                    state.RespawnAt = null;
                    state.Health = state.MaxHealth;
                    changed = true;
                }
            }

            if (changed)
            {
                var snapshot = BuildSnapshot(kvp.Key);
                if (snapshot != null)
                {
                    result.Add(snapshot);
                }
            }
        }

        return result;
    }

    public EnvironmentObjectDto? BuildSnapshot(string environmentId)
    {
        if (!_blueprints.TryGetValue(environmentId, out var blueprint))
        {
            return null;
        }

        if (!_states.TryGetValue(environmentId, out var runtime))
        {
            return null;
        }

        bool isActive;
        double cooldownRemaining;
        double healthFraction;

        lock (runtime)
        {
            if (!runtime.IsActive && runtime.RespawnAt.HasValue && runtime.RespawnAt.Value <= DateTime.UtcNow)
            {
                runtime.IsActive = true;
                runtime.RespawnAt = null;
                runtime.Health = runtime.MaxHealth;
            }

            isActive = runtime.IsActive;
            cooldownRemaining = runtime.RespawnAt.HasValue
                ? Math.Max(0, (runtime.RespawnAt.Value - DateTime.UtcNow).TotalSeconds)
                : 0;
            healthFraction = runtime.MaxHealth > 0
                ? Math.Clamp(runtime.Health / runtime.MaxHealth, 0, 1)
                : 0;
        }

        return new EnvironmentObjectDto
        {
            Id = blueprint.Id,
            ChunkX = blueprint.ChunkX,
            ChunkZ = blueprint.ChunkZ,
            Type = blueprint.Type,
            X = blueprint.X,
            Y = blueprint.Y,
            Z = blueprint.Z,
            Rotation = blueprint.Rotation,
            State = new EnvironmentStateDto
            {
                IsActive = isActive,
                CooldownRemaining = cooldownRemaining,
                HealthFraction = healthFraction
            }
        };
    }

    private sealed class EnvironmentRuntimeState
    {
        public bool IsActive { get; set; } = true;
        public DateTime? RespawnAt { get; set; }
        public double MaxHealth { get; set; } = 1.0;
        public double Health { get; set; } = 1.0;

        public void ConfigureForBlueprint(EnvironmentBlueprint blueprint, GameWorldOptions options, bool resetState)
        {
            if (string.Equals(blueprint.Type, "sentinel", StringComparison.OrdinalIgnoreCase))
            {
                MaxHealth = options.SentinelBaseHealth;
            }
            else
            {
                MaxHealth = 1.0;
            }

            if (MaxHealth <= 0)
            {
                MaxHealth = 1.0;
            }

            if (resetState)
            {
                IsActive = true;
                RespawnAt = null;
                Health = MaxHealth;
            }
            else
            {
                if (Health <= 0 || Health > MaxHealth)
                {
                    Health = MaxHealth;
                }
            }
        }
    }
}

public readonly struct EnvironmentTargetInfo
{
    public EnvironmentTargetInfo(string id, string type, double x, double y, double z, bool isActive)
    {
        Id = id;
        Type = type;
        X = x;
        Y = y;
        Z = z;
        IsActive = isActive;
    }

    public string Id { get; }
    public string Type { get; }
    public double X { get; }
    public double Y { get; }
    public double Z { get; }
    public bool IsActive { get; }
}
