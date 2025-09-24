using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Linq;

namespace SingularityApi.Controllers
{
    public static class WebSocketController
    {
        private const int CHUNK_SIZE = 16;
        private const int WORLD_SEED = 1337;
        private const double MAX_MOVE_DISTANCE_SQ = 36.0;
        private const int TERRAIN_OCTAVES = 5;
        private const double TERRAIN_PERSISTENCE = 0.5;
        private const double TERRAIN_BASE_FREQUENCY = 0.01;
        private const double TERRAIN_BASE_AMPLITUDE = 8.0;
        private const double DAY_LENGTH_SECONDS = 480.0;
        private const double SENTINEL_BASE_HEALTH = 40.0;
        private const double SENTINEL_RESPAWN_SECONDS = 18.0;
        private const int SENTINEL_XP_REWARD = 35;

        private static readonly ConcurrentDictionary<(int, int), ChunkData> ChunkCache = new();
        private static readonly ConcurrentDictionary<string, PlayerState> Players = new();
        private static readonly ConcurrentDictionary<string, WebSocket> Connections = new();
        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private static readonly Timer WorldTimer;
        private static readonly object WorldClockLock = new();
        private static double _timeOfDayFraction = 0.25;

        static WebSocketController()
        {
            WorldTimer = new Timer(WorldTick, null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
        }

        public static async Task HandleWebsocket(this HttpContext context)
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = 400;
                return;
            }

            using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
            var connectionId = Guid.NewGuid().ToString();
            Connections[connectionId] = webSocket;

            var spawnX = 0.0;
            var spawnZ = 0.0;
            var groundY = SampleTerrainHeight(spawnX, spawnZ);
            var playerState = new PlayerState
            {
                Id = connectionId,
                DisplayName = $"Explorer-{connectionId[..8]}",
                X = spawnX,
                Y = groundY + 2.0,
                Z = spawnZ,
                Heading = 0,
                VelocityX = 0,
                VelocityZ = 0,
                LastUpdate = DateTime.UtcNow
            };
            Players[connectionId] = playerState;

            await SendInitialStateAsync(webSocket, connectionId, context.RequestAborted);
            await BroadcastJsonAsync(new { type = "playerJoined", player = CreatePlayerSnapshot(playerState) }, connectionId);

            var buffer = new byte[1024 * 8];

            try
            {
                while (!context.RequestAborted.IsCancellationRequested && webSocket.State == WebSocketState.Open)
                {
                    var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), context.RequestAborted);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        break;
                    }

                    var clientMsg = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    try
                    {
                        using var jsonDoc = JsonDocument.Parse(clientMsg);
                        await HandleClientMessage(connectionId, webSocket, jsonDoc.RootElement, context.RequestAborted);
                    }
                    catch (JsonException jsonEx)
                    {
                        Console.WriteLine($"Invalid JSON from {connectionId}: {jsonEx.Message}");
                    }
                }
            }
            catch (OperationCanceledException)
            {
            }
            catch (WebSocketException wsEx)
            {
                Console.WriteLine($"WebSocket error ({connectionId}): {wsEx.Message}");
            }
            finally
            {
                Players.TryRemove(connectionId, out _);
                Connections.TryRemove(connectionId, out _);

                if (webSocket.State == WebSocketState.Open || webSocket.State == WebSocketState.CloseReceived)
                {
                    try
                    {
                        await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, string.Empty, CancellationToken.None);
                    }
                    catch
                    {
                    }
                }

                await BroadcastJsonAsync(new { type = "playerLeft", playerId = connectionId }, connectionId);
            }
        }

        private static async Task HandleClientMessage(string connectionId, WebSocket socket, JsonElement root, CancellationToken cancel)
        {
            if (!root.TryGetProperty("type", out var typeProperty))
            {
                return;
            }

            var msgType = typeProperty.GetString();
            switch (msgType)
            {
                case "playerTransform":
                    await HandlePlayerTransformAsync(connectionId, root);
                    break;

                case "requestNearbyChunks":
                    await HandleChunkRequestAsync(connectionId, socket, root, cancel);
                    break;

                case "interact":
                    await HandleInteractionAsync(connectionId, root);
                    break;

                default:
                    Console.WriteLine($"Unknown message type '{msgType}' from {connectionId}");
                    break;
            }
        }

        private static async Task HandlePlayerTransformAsync(string connectionId, JsonElement root)
        {
            if (!Players.TryGetValue(connectionId, out var state))
            {
                return;
            }

            if (!TryGetDouble(root, "x", out var x) ||
                !TryGetDouble(root, "y", out var y) ||
                !TryGetDouble(root, "z", out var z) ||
                !TryGetDouble(root, "heading", out var heading))
            {
                return;
            }

            TryGetDouble(root, "velocityX", out var velocityX);
            TryGetDouble(root, "velocityZ", out var velocityZ);

            if (!double.IsFinite(x) || !double.IsFinite(y) || !double.IsFinite(z))
            {
                return;
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
                if (distanceSq > MAX_MOVE_DISTANCE_SQ)
                {
                    var distance = Math.Sqrt(distanceSq);
                    if (distance > 0)
                    {
                        var scale = Math.Sqrt(MAX_MOVE_DISTANCE_SQ) / distance;
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
            }

            await BroadcastPlayerStateAsync(state);
        }

        private static async Task HandleChunkRequestAsync(string connectionId, WebSocket socket, JsonElement root, CancellationToken cancel)
        {
            if (!Players.TryGetValue(connectionId, out var state))
            {
                return;
            }

            var radius = 1;
            if (root.TryGetProperty("radius", out var radiusProp) && radiusProp.ValueKind == JsonValueKind.Number)
            {
                radius = Math.Clamp(radiusProp.GetInt32(), 1, 4);
            }

            int chunkX;
            int chunkZ;

            lock (state)
            {
                chunkX = (int)Math.Floor(state.X / CHUNK_SIZE);
                chunkZ = (int)Math.Floor(state.Z / CHUNK_SIZE);
            }

            var chunkResponses = new List<object>();

            for (var cx = chunkX - radius; cx <= chunkX + radius; cx++)
            {
                for (var cz = chunkZ - radius; cz <= chunkZ + radius; cz++)
                {
                    var chunk = GetOrGenerateChunk(cx, cz);
                    var environmentObjects = EnvironmentManager.CreateSnapshotForChunk(chunk);
                    chunkResponses.Add(new
                    {
                        x = cx,
                        z = cz,
                        vertices = chunk.Vertices,
                        environmentObjects
                    });
                }
            }

            var payload = new
            {
                type = "nearbyChunksResponse",
                centerChunkX = chunkX,
                centerChunkZ = chunkZ,
                chunkSize = CHUNK_SIZE,
                chunks = chunkResponses
            };

            await SendJsonAsync(socket, payload, cancel);
        }

        private static async Task HandleInteractionAsync(string playerId, JsonElement root)
        {
            if (!root.TryGetProperty("environmentId", out var idProp))
            {
                return;
            }

            var environmentId = idProp.GetString();
            if (string.IsNullOrWhiteSpace(environmentId))
            {
                return;
            }

            if (!Players.TryGetValue(playerId, out var playerState))
            {
                return;
            }

            double attackPower;
            lock (playerState)
            {
                attackPower = playerState.Stats.Attack;
            }

            if (EnvironmentManager.TryStrike(environmentId, attackPower, out var updated, out var defeated) && updated != null)
            {
                await BroadcastJsonAsync(new { type = "environmentUpdate", environmentObject = updated });

                if (defeated)
                {
                    await GrantExperienceAsync(playerState, SENTINEL_XP_REWARD, "Sentinel defeated");
                }
            }
        }

        private static async Task SendInitialStateAsync(WebSocket socket, string connectionId, CancellationToken cancel)
        {
            var otherPlayers = Players.Values
                .Where(p => p.Id != connectionId)
                .Select(CreatePlayerSnapshot)
                .ToList();

            PlayerStatsDto? statsSnapshot = null;
            if (Players.TryGetValue(connectionId, out var playerState))
            {
                statsSnapshot = BuildStatsSnapshot(playerState);
            }

            var payload = new
            {
                type = "initialState",
                playerId = connectionId,
                worldSeed = WORLD_SEED,
                timeOfDay = GetTimeOfDayFraction(),
                players = otherPlayers,
                stats = statsSnapshot
            };

            await SendJsonAsync(socket, payload, cancel);
        }

        private static Task GrantExperienceAsync(PlayerState state, int xpAwarded, string reason)
        {
            PlayerStatsDto snapshot;
            bool leveledUp;

            lock (state)
            {
                var stats = state.Stats;
                stats.Experience += xpAwarded;
                leveledUp = false;

                while (stats.Experience >= stats.ExperienceToNext)
                {
                    stats.Experience -= stats.ExperienceToNext;
                    stats.Level++;
                    stats.Attack += 2;
                    stats.MaxHealth += 10;
                    stats.CurrentHealth = stats.MaxHealth;
                    stats.ExperienceToNext = CalculateExperienceForNext(stats.Level);
                    leveledUp = true;
                }

                snapshot = new PlayerStatsDto
                {
                    Level = stats.Level,
                    Experience = stats.Experience,
                    ExperienceToNext = stats.ExperienceToNext,
                    Attack = stats.Attack,
                    MaxHealth = stats.MaxHealth,
                    CurrentHealth = stats.CurrentHealth
                };
            }

            return SendPlayerStatsAsync(state, snapshot, xpAwarded, leveledUp, reason);
        }

        private static Task SendPlayerStatsAsync(PlayerState state, PlayerStatsDto snapshot, int xpAwarded, bool leveledUp, string reason)
        {
            if (!Connections.TryGetValue(state.Id, out var socket) || socket.State != WebSocketState.Open)
            {
                return Task.CompletedTask;
            }

            var payload = new
            {
                type = "playerStats",
                stats = snapshot,
                xpAwarded,
                leveledUp,
                reason
            };

            return SendJsonAsync(socket, payload, CancellationToken.None);
        }

        private static PlayerStatsDto BuildStatsSnapshot(PlayerState state)
        {
            lock (state)
            {
                return new PlayerStatsDto
                {
                    Level = state.Stats.Level,
                    Experience = state.Stats.Experience,
                    ExperienceToNext = state.Stats.ExperienceToNext,
                    Attack = state.Stats.Attack,
                    MaxHealth = state.Stats.MaxHealth,
                    CurrentHealth = state.Stats.CurrentHealth
                };
            }
        }

        private static PlayerStats CreateInitialStats()
        {
            var required = CalculateExperienceForNext(1);
            return new PlayerStats
            {
                Level = 1,
                Experience = 0,
                ExperienceToNext = required,
                Attack = 8,
                MaxHealth = 120,
                CurrentHealth = 120
            };
        }

        private static int CalculateExperienceForNext(int level)
        {
            return 80 + Math.Max(0, level - 1) * 35;
        }

        private static Task BroadcastPlayerStateAsync(PlayerState state)
        {
            var snapshot = CreatePlayerSnapshot(state);
            return BroadcastJsonAsync(new { type = "playerState", player = snapshot });
        }

        private static PlayerSnapshot CreatePlayerSnapshot(PlayerState state)
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
        private static ChunkData GetOrGenerateChunk(int cx, int cz)
        {
            return ChunkCache.GetOrAdd((cx, cz), key => GenerateChunkData(key.Item1, key.Item2));
        }

        private static ChunkData GenerateChunkData(int cx, int cz)
        {
            var vertices = new List<Vertex>((CHUNK_SIZE + 1) * (CHUNK_SIZE + 1));

            for (var z = 0; z <= CHUNK_SIZE; z++)
            {
                for (var x = 0; x <= CHUNK_SIZE; x++)
                {
                    var worldX = cx * CHUNK_SIZE + x;
                    var worldZ = cz * CHUNK_SIZE + z;
                    var height = SampleTerrainHeight(worldX, worldZ);

                    vertices.Add(new Vertex
                    {
                        X = worldX,
                        Y = height,
                        Z = worldZ
                    });
                }
            }

            var blueprints = GenerateEnvironmentBlueprints(cx, cz);

            return new ChunkData(vertices, blueprints);
        }

        private static List<EnvironmentBlueprint> GenerateEnvironmentBlueprints(int cx, int cz)
        {
            var seed = HashCode.Combine(cx, cz, WORLD_SEED);
            var rng = new Random(seed);
            var count = rng.Next(4, 9);
            var blueprints = new List<EnvironmentBlueprint>(count);

            for (var i = 0; i < count; i++)
            {
                var offsetX = rng.NextDouble() * CHUNK_SIZE;
                var offsetZ = rng.NextDouble() * CHUNK_SIZE;

                var worldX = cx * CHUNK_SIZE + offsetX;
                var worldZ = cz * CHUNK_SIZE + offsetZ;
                var worldY = SampleTerrainHeight(worldX, worldZ);

                var type = rng.NextDouble() < 0.7 ? "tree" : "sentinel";

                var blueprint = new EnvironmentBlueprint
                {
                    Id = $"env-{cx}-{cz}-{i}",
                    ChunkX = cx,
                    ChunkZ = cz,
                    Type = type,
                    X = worldX,
                    Y = worldY,
                    Z = worldZ,
                    Rotation = rng.NextDouble() * Math.PI * 2
                };

                blueprints.Add(blueprint);
                EnvironmentManager.EnsureBlueprint(blueprint);
            }

            return blueprints;
        }

        private static double SampleTerrainHeight(double x, double z)
        {
            return LayeredPerlin2D(x, z, TERRAIN_OCTAVES, TERRAIN_PERSISTENCE, TERRAIN_BASE_FREQUENCY, TERRAIN_BASE_AMPLITUDE);
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

        private static Task SendJsonAsync(WebSocket socket, object payload, CancellationToken cancel)
        {
            var json = JsonSerializer.Serialize(payload, JsonOptions);
            var buffer = Encoding.UTF8.GetBytes(json);
            return socket.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, cancel);
        }

        private static Task BroadcastJsonAsync(object payload, string? exceptId = null)
        {
            var json = JsonSerializer.Serialize(payload, JsonOptions);
            var buffer = Encoding.UTF8.GetBytes(json);

            var tasks = new List<Task>();
            foreach (var kv in Connections)
            {
                if (exceptId != null && kv.Key == exceptId)
                {
                    continue;
                }

                var socket = kv.Value;
                if (socket.State != WebSocketState.Open)
                {
                    continue;
                }

                tasks.Add(SendBufferSafeAsync(kv.Key, socket, buffer));
            }

            if (tasks.Count == 0)
            {
                return Task.CompletedTask;
            }

            return Task.WhenAll(tasks);
        }

        private static async Task SendBufferSafeAsync(string connectionId, WebSocket socket, byte[] buffer)
        {
            try
            {
                await socket.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch
            {
                Connections.TryRemove(connectionId, out _);
                Players.TryRemove(connectionId, out _);
            }
        }

        private static void WorldTick(object? _)
        {
            if (Connections.IsEmpty)
            {
                return;
            }

            var respawns = EnvironmentManager.CollectRespawns();
            if (respawns.Count > 0)
            {
                foreach (var obj in respawns)
                {
                    _ = BroadcastJsonAsync(new { type = "environmentUpdate", environmentObject = obj });
                }
            }

            var timeOfDay = AdvanceWorldClock(TimeSpan.FromSeconds(1));
            _ = BroadcastJsonAsync(new { type = "worldTick", timeOfDay });
        }

        private static double AdvanceWorldClock(TimeSpan delta)
        {
            lock (WorldClockLock)
            {
                var increment = delta.TotalSeconds / DAY_LENGTH_SECONDS;
                _timeOfDayFraction = (_timeOfDayFraction + increment) % 1.0;
                if (_timeOfDayFraction < 0)
                {
                    _timeOfDayFraction += 1.0;
                }

                return _timeOfDayFraction;
            }
        }

        private static double GetTimeOfDayFraction()
        {
            lock (WorldClockLock)
            {
                return _timeOfDayFraction;
            }
        }

        private static bool TryGetDouble(JsonElement root, string propertyName, out double value)
        {
            value = 0;
            if (root.TryGetProperty(propertyName, out var prop) && prop.ValueKind == JsonValueKind.Number)
            {
                value = prop.GetDouble();
                return true;
            }

            return false;
        }
        private class PlayerState
        {
            public string Id { get; set; } = string.Empty;
            public string DisplayName { get; set; } = string.Empty;
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
            public double Heading { get; set; }
            public double VelocityX { get; set; }
            public double VelocityZ { get; set; }
            public DateTime LastUpdate { get; set; }
            public PlayerStats Stats { get; } = CreateInitialStats();
        }

        private class PlayerSnapshot
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

        private class PlayerStats
        {
            public int Level { get; set; }
            public int Experience { get; set; }
            public int ExperienceToNext { get; set; }
            public int Attack { get; set; }
            public int MaxHealth { get; set; }
            public int CurrentHealth { get; set; }
        }

        private class PlayerStatsDto
        {
            public int Level { get; set; }
            public int Experience { get; set; }
            public int ExperienceToNext { get; set; }
            public int Attack { get; set; }
            public int MaxHealth { get; set; }
            public int CurrentHealth { get; set; }
        }

        public class Vertex
        {
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
        }

        private class ChunkData
        {
            public ChunkData(List<Vertex> vertices, List<EnvironmentBlueprint> environmentBlueprints)
            {
                Vertices = vertices;
                EnvironmentBlueprints = environmentBlueprints;
            }

            public List<Vertex> Vertices { get; }
            public List<EnvironmentBlueprint> EnvironmentBlueprints { get; }
        }

        private class EnvironmentBlueprint
        {
            public string Id { get; set; } = string.Empty;
            public int ChunkX { get; set; }
            public int ChunkZ { get; set; }
            public string Type { get; set; } = "tree";
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
            public double Rotation { get; set; }
        }

        private class EnvironmentObjectDto
        {
            public string Id { get; set; } = string.Empty;
            public int ChunkX { get; set; }
            public int ChunkZ { get; set; }
            public string Type { get; set; } = string.Empty;
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
            public double Rotation { get; set; }
            public EnvironmentStateDto State { get; set; } = new EnvironmentStateDto();
        }

        private class EnvironmentStateDto
        {
            public bool IsActive { get; set; }
            public double CooldownRemaining { get; set; }
            public double HealthFraction { get; set; }
        }

        private static class EnvironmentManager
        {
            private static readonly ConcurrentDictionary<string, EnvironmentBlueprint> Blueprints = new();
            private static readonly ConcurrentDictionary<string, EnvironmentRuntimeState> States = new();

            public static void EnsureBlueprint(EnvironmentBlueprint blueprint)
            {
                Blueprints.AddOrUpdate(blueprint.Id, blueprint, (_, existing) => existing);
                States.AddOrUpdate(
                    blueprint.Id,
                    _ =>
                    {
                        var runtime = new EnvironmentRuntimeState();
                        runtime.ConfigureForBlueprint(blueprint, resetState: true);
                        return runtime;
                    },
                    (_, existing) =>
                    {
                        lock (existing)
                        {
                            existing.ConfigureForBlueprint(blueprint, resetState: false);
                            return existing;
                        }
                    });
            }

            public static List<EnvironmentObjectDto> CreateSnapshotForChunk(ChunkData chunk)
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

            public static bool TryStrike(string environmentId, double damage, out EnvironmentObjectDto? updated, out bool defeated)
            {
                updated = null;
                defeated = false;

                if (!Blueprints.TryGetValue(environmentId, out var blueprint) ||
                    !States.TryGetValue(environmentId, out var state))
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
                        state.RespawnAt = DateTime.UtcNow.AddSeconds(SENTINEL_RESPAWN_SECONDS);
                        state.Health = 0;
                        defeated = true;
                    }
                }

                updated = BuildSnapshot(environmentId);
                return updated != null;
            }

            public static List<EnvironmentObjectDto> CollectRespawns()
            {
                var result = new List<EnvironmentObjectDto>();

                foreach (var kvp in States)
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

            private static EnvironmentObjectDto? BuildSnapshot(string environmentId)
            {
                if (!Blueprints.TryGetValue(environmentId, out var blueprint))
                {
                    return null;
                }

                if (!States.TryGetValue(environmentId, out var runtime))
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

            private class EnvironmentRuntimeState
            {
                public bool IsActive { get; set; } = true;
                public DateTime? RespawnAt { get; set; }
                public double MaxHealth { get; set; } = 1.0;
                public double Health { get; set; } = 1.0;

                public void ConfigureForBlueprint(EnvironmentBlueprint blueprint, bool resetState)
                {
                    if (string.Equals(blueprint.Type, "sentinel", StringComparison.OrdinalIgnoreCase))
                    {
                        MaxHealth = SENTINEL_BASE_HEALTH;
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
    }
}
