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
        private const double MOB_BASE_HEALTH = 60.0;
        private const double MOB_RESPAWN_SECONDS = 20.0;
        private const int MOB_XP_REWARD = 55;
        private const double MOB_ATTACK_DAMAGE = 14.0;
        private const double MOB_ATTACK_COOLDOWN = 2.2;
        private const double MOB_MOVE_SPEED = 4.6;
        private const double MOB_AGGRO_RANGE = 24.0;
        private const double MOB_ATTACK_RANGE = 2.4;

        private static readonly AbilityDefinition[] AbilityDefinitions = new[]
        {
            new AbilityDefinition
            {
                Id = "autoAttack",
                Name = "Auto Attack",
                Key = "1",
                CooldownSeconds = 1.6,
                DamageMultiplier = 1.0,
                UnlockLevel = 1,
                ResetOnLevelUp = false
            },
            new AbilityDefinition
            {
                Id = "instantStrike",
                Name = "Skyburst Strike",
                Key = "2",
                CooldownSeconds = 10.0,
                DamageMultiplier = 2.6,
                UnlockLevel = 2,
                ResetOnLevelUp = true
            }
        };

        private static readonly ConcurrentDictionary<(int, int), ChunkData> ChunkCache = new();
        private static readonly ConcurrentDictionary<string, PlayerState> Players = new();
        private static readonly ConcurrentDictionary<string, WebSocket> Connections = new();
        private static readonly JsonSerializerOptions JsonOptions = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
        };

        private static readonly Timer WorldTimer;
        private static DateTime _lastWorldTick = DateTime.UtcNow;
        private static readonly object WorldClockLock = new();
        private static double _timeOfDayFraction = 0.25;

        static WebSocketController()
        {
            WorldTimer = new Timer(WorldTick, null, TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(100));
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

                case "useSkill":
                    await HandleAbilityMessageAsync(connectionId, root);
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
                        var mobs = MobManager.CreateSnapshotForChunk(chunk);
                        chunkResponses.Add(new
                        {
                            x = cx,
                            z = cz,
                            vertices = chunk.Vertices,
                            environmentObjects,
                            mobs
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

        private static Task HandleInteractionAsync(string playerId, JsonElement root)
        {
            if (!root.TryGetProperty("targetId", out var idProp))
            {
                if (!root.TryGetProperty("environmentId", out idProp))
                {
                    return Task.CompletedTask;
                }
            }

            var targetId = idProp.GetString();
            if (string.IsNullOrWhiteSpace(targetId))
            {
                return Task.CompletedTask;
            }

            return ExecuteAbilityAsync(playerId, "autoAttack", targetId);
        }

        private static Task HandleAbilityMessageAsync(string playerId, JsonElement root)
        {
            if (!root.TryGetProperty("abilityId", out var abilityProp))
            {
                return Task.CompletedTask;
            }

            var abilityId = abilityProp.GetString();
            if (string.IsNullOrWhiteSpace(abilityId))
            {
                return Task.CompletedTask;
            }

            string? targetId = null;
            if (root.TryGetProperty("targetId", out var targetProp) && targetProp.ValueKind == JsonValueKind.String)
            {
                targetId = targetProp.GetString();
            }
            else if (root.TryGetProperty("environmentId", out var envProp) && envProp.ValueKind == JsonValueKind.String)
            {
                targetId = envProp.GetString();
            }

            return ExecuteAbilityAsync(playerId, abilityId, targetId);
        }

        private static async Task ExecuteAbilityAsync(string playerId, string abilityId, string? targetId)
        {
            if (!Players.TryGetValue(playerId, out var playerState))
            {
                return;
            }

            var abilityDefinition = AbilityDefinitions.FirstOrDefault(a =>
                string.Equals(a.Id, abilityId, StringComparison.OrdinalIgnoreCase));
            if (abilityDefinition == null)
            {
                return;
            }

            var now = DateTime.UtcNow;
            PlayerStatsDto statsSnapshot;
            List<AbilityDto> abilitySnapshots;
            var shouldStrike = false;
            double damage = 0;

            lock (playerState)
            {
                if (!playerState.Abilities.TryGetValue(abilityDefinition.Id, out var abilityState))
                {
                    abilityState = new PlayerAbilityState
                    {
                        AbilityId = abilityDefinition.Id,
                        CooldownUntil = now,
                        Unlocked = false
                    };
                    playerState.Abilities[abilityDefinition.Id] = abilityState;
                }

                var stats = playerState.Stats;
                abilityState.Unlocked = stats.Level >= abilityDefinition.UnlockLevel;

                if (abilityState.Unlocked && abilityState.CooldownUntil <= now && !string.IsNullOrWhiteSpace(targetId))
                {
                    var cooldown = Math.Max(0.2, abilityDefinition.CooldownSeconds);
                    abilityState.CooldownUntil = now.AddSeconds(cooldown);
                    damage = Math.Max(1.0, stats.Attack * abilityDefinition.DamageMultiplier);
                    shouldStrike = true;
                }

                statsSnapshot = new PlayerStatsDto
                {
                    Level = stats.Level,
                    Experience = stats.Experience,
                    ExperienceToNext = stats.ExperienceToNext,
                    Attack = stats.Attack,
                    MaxHealth = stats.MaxHealth,
                    CurrentHealth = stats.CurrentHealth
                };

                abilitySnapshots = BuildAbilitySnapshotsLocked(playerState, leveledUp: false, now);
            }

            await SendPlayerStatsAsync(playerState, statsSnapshot, 0, false, null, abilitySnapshots);

            if (!shouldStrike || string.IsNullOrWhiteSpace(targetId))
            {
                return;
            }

            await BroadcastJsonAsync(new { type = "playerAbility", playerId, abilityId = abilityDefinition.Id, targetId });

            if (MobManager.TryStrike(targetId, damage, playerId, out var mobUpdate, out var mobDefeated, out var mobName))
            {
                if (mobUpdate != null)
                {
                    await BroadcastJsonAsync(new { type = "mobUpdate", mobs = new[] { mobUpdate } });
                }

                if (mobDefeated)
                {
                    await GrantExperienceAsync(playerState, MOB_XP_REWARD, $"{mobName} defeated");
                }

                return;
            }

            if (!EnvironmentManager.TryStrike(targetId, damage, out var updated, out var defeated) || updated == null)
            {
                return;
            }

            await BroadcastJsonAsync(new { type = "environmentUpdate", environmentObject = updated });

            if (defeated)
            {
                await GrantExperienceAsync(playerState, SENTINEL_XP_REWARD, "Sentinel defeated");
            }
        }

        private static async Task SendInitialStateAsync(WebSocket socket, string connectionId, CancellationToken cancel)
        {
            var otherPlayers = Players.Values
                .Where(p => p.Id != connectionId)
                .Select(CreatePlayerSnapshot)
                .ToList();

            PlayerStatsDto? statsSnapshot = null;
            List<AbilityDto>? abilitySnapshots = null;
            if (Players.TryGetValue(connectionId, out var playerState))
            {
                statsSnapshot = BuildStatsSnapshot(playerState);
                abilitySnapshots = BuildAbilitySnapshots(playerState);
            }

            var payload = new
            {
                type = "initialState",
                playerId = connectionId,
                worldSeed = WORLD_SEED,
                timeOfDay = GetTimeOfDayFraction(),
                players = otherPlayers,
                stats = statsSnapshot,
                abilities = abilitySnapshots
            };

            await SendJsonAsync(socket, payload, cancel);
        }

        private static Task GrantExperienceAsync(PlayerState state, int xpAwarded, string reason)
        {
            PlayerStatsDto snapshot;
            bool leveledUp;
            List<AbilityDto> abilities;

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

                abilities = BuildAbilitySnapshotsLocked(state, leveledUp, DateTime.UtcNow);
            }

            return SendPlayerStatsAsync(state, snapshot, xpAwarded, leveledUp, reason, abilities);
        }

        private static Task SendPlayerStatsAsync(
            PlayerState state,
            PlayerStatsDto snapshot,
            int xpAwarded,
            bool leveledUp,
            string? reason,
            IReadOnlyList<AbilityDto>? abilities = null)
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
                reason,
                abilities
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

        private static List<AbilityDto> BuildAbilitySnapshots(PlayerState state)
        {
            lock (state)
            {
                return BuildAbilitySnapshotsLocked(state, leveledUp: false, DateTime.UtcNow);
            }
        }

        private static List<AbilityDto> BuildAbilitySnapshotsLocked(PlayerState state, bool leveledUp, DateTime now)
        {
            var list = new List<AbilityDto>(AbilityDefinitions.Length);

            foreach (var definition in AbilityDefinitions)
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

                var unlocked = state.Stats.Level >= definition.UnlockLevel;

                if (!unlocked)
                {
                    abilityState.Unlocked = false;
                    abilityState.CooldownUntil = now;
                }
                else
                {
                    if (!abilityState.Unlocked)
                    {
                        abilityState.CooldownUntil = now;
                    }
                    else if (leveledUp && definition.ResetOnLevelUp)
                    {
                        abilityState.CooldownUntil = now;
                    }

                    abilityState.Unlocked = true;
                }

                var remaining = abilityState.CooldownUntil > now
                    ? Math.Max(0, (abilityState.CooldownUntil - now).TotalSeconds)
                    : 0;

                list.Add(new AbilityDto
                {
                    Id = definition.Id,
                    Name = definition.Name,
                    Key = definition.Key,
                    Cooldown = Math.Max(0, definition.CooldownSeconds),
                    CooldownRemaining = remaining,
                    Unlocked = abilityState.Unlocked
                });
            }

            return list;
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

        private static Dictionary<string, PlayerAbilityState> InitializeAbilities()
        {
            var dict = new Dictionary<string, PlayerAbilityState>(StringComparer.OrdinalIgnoreCase);
            var now = DateTime.UtcNow;
            foreach (var definition in AbilityDefinitions)
            {
                dict[definition.Id] = new PlayerAbilityState
                {
                    AbilityId = definition.Id,
                    Unlocked = definition.UnlockLevel <= 1,
                    CooldownUntil = now
                };
            }

            return dict;
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

            var worldObjects = GenerateEnvironmentAndMobBlueprints(cx, cz);

            return new ChunkData(vertices, worldObjects.EnvironmentBlueprints, worldObjects.MobBlueprints);
        }

        private static (List<EnvironmentBlueprint> EnvironmentBlueprints, List<MobBlueprint> MobBlueprints) GenerateEnvironmentAndMobBlueprints(int cx, int cz)
        {
            var seed = HashCode.Combine(cx, cz, WORLD_SEED);
            var rng = new Random(seed);
            var count = rng.Next(4, 9);
            var environmentBlueprints = new List<EnvironmentBlueprint>(count);
            var mobBlueprints = new List<MobBlueprint>();

            for (var i = 0; i < count; i++)
            {
                var offsetX = rng.NextDouble() * CHUNK_SIZE;
                var offsetZ = rng.NextDouble() * CHUNK_SIZE;

                var worldX = cx * CHUNK_SIZE + offsetX;
                var worldZ = cz * CHUNK_SIZE + offsetZ;
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
                    EnvironmentManager.EnsureBlueprint(blueprint);
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
                    MobManager.EnsureBlueprint(mobBlueprint);
                }
            }

            return (environmentBlueprints, mobBlueprints);
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
            var now = DateTime.UtcNow;
            var delta = now - _lastWorldTick;
            if (delta.TotalSeconds <= 0)
            {
                delta = TimeSpan.FromMilliseconds(100);
            }
            _lastWorldTick = now;

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

            var observations = BuildPlayerObservations();
            var mobResult = MobManager.Tick(delta, observations);

            if (mobResult.Updates.Count > 0)
            {
                _ = BroadcastJsonAsync(new { type = "mobUpdate", mobs = mobResult.Updates });
            }

            foreach (var attack in mobResult.Attacks)
            {
                if (Players.TryGetValue(attack.PlayerId, out var playerState))
                {
                    var damageResult = ProcessMobDamage(playerState, attack.Damage, attack.MobName);
                    _ = SendPlayerStatsAsync(playerState, damageResult.Snapshot, 0, false, damageResult.Reason);

                    if (damageResult.Defeated)
                    {
                        _ = HandlePlayerDefeatAsync(playerState, attack.MobName);
                    }
                }

                _ = BroadcastJsonAsync(new { type = "mobAttack", mobId = attack.MobId, targetId = attack.PlayerId });
            }

            var timeOfDay = AdvanceWorldClock(delta);
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
            public Dictionary<string, PlayerAbilityState> Abilities { get; } = InitializeAbilities();
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

        private class PlayerAbilityState
        {
            public string AbilityId { get; set; } = string.Empty;
            public bool Unlocked { get; set; }
            public DateTime CooldownUntil { get; set; } = DateTime.UtcNow;
        }

        private class AbilityDto
        {
            public string Id { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public string Key { get; set; } = string.Empty;
            public double Cooldown { get; set; }
            public double CooldownRemaining { get; set; }
            public bool Unlocked { get; set; }
        }

        private class AbilityDefinition
        {
            public string Id { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public string Key { get; set; } = string.Empty;
            public double CooldownSeconds { get; set; }
            public double DamageMultiplier { get; set; }
            public int UnlockLevel { get; set; } = 1;
            public bool ResetOnLevelUp { get; set; }
        }

        public class Vertex
        {
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
        }

        private class ChunkData
        {
            public ChunkData(
                List<Vertex> vertices,
                List<EnvironmentBlueprint> environmentBlueprints,
                List<MobBlueprint> mobBlueprints)
            {
                Vertices = vertices;
                EnvironmentBlueprints = environmentBlueprints;
                MobBlueprints = mobBlueprints;
            }

            public List<Vertex> Vertices { get; }
            public List<EnvironmentBlueprint> EnvironmentBlueprints { get; }
            public List<MobBlueprint> MobBlueprints { get; }
        }

        private class MobBlueprint
        {
            public string Id { get; set; } = string.Empty;
            public int ChunkX { get; set; }
            public int ChunkZ { get; set; }
            public string Type { get; set; } = "hunter";
            public string Name { get; set; } = "Aether Hunter";
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
        }

        private class MobSnapshotDto
        {
            public string Id { get; set; } = string.Empty;
            public int ChunkX { get; set; }
            public int ChunkZ { get; set; }
            public string Type { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
            public double Heading { get; set; }
            public bool IsAlive { get; set; }
            public double HealthFraction { get; set; }
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

        private static Dictionary<string, PlayerObservation> BuildPlayerObservations()
        {
            var observations = new Dictionary<string, PlayerObservation>(Players.Count);

            foreach (var kvp in Players)
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

        private static (PlayerStatsDto Snapshot, string? Reason, bool Defeated) ProcessMobDamage(PlayerState state, double damage, string mobName)
        {
            PlayerStatsDto snapshot;
            bool defeated;
            int appliedDamage;

            lock (state)
            {
                appliedDamage = (int)Math.Max(1, Math.Round(damage));
                var stats = state.Stats;
                stats.CurrentHealth = Math.Max(0, stats.CurrentHealth - appliedDamage);
                defeated = stats.CurrentHealth <= 0;

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

            var reason = defeated ? null : $"{mobName} hit you for {appliedDamage}.";
            return (snapshot, reason, defeated);
        }

        private static async Task HandlePlayerDefeatAsync(PlayerState state, string mobName)
        {
            PlayerStatsDto snapshot;
            List<AbilityDto> abilities;

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
                    Attack = state.Stats.Attack,
                    MaxHealth = state.Stats.MaxHealth,
                    CurrentHealth = state.Stats.CurrentHealth
                };

                abilities = BuildAbilitySnapshotsLocked(state, leveledUp: false, DateTime.UtcNow);
            }

            await BroadcastPlayerStateAsync(state);
            await SendPlayerStatsAsync(state, snapshot, 0, false, $"You were defeated by {mobName}.", abilities);
        }

        private readonly struct PlayerObservation
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

        private static class MobManager
        {
            private static readonly ConcurrentDictionary<string, MobBlueprint> Blueprints = new();
            private static readonly ConcurrentDictionary<string, MobRuntimeState> States = new();

            public static void EnsureBlueprint(MobBlueprint blueprint)
            {
                Blueprints.AddOrUpdate(blueprint.Id, blueprint, (_, _) => blueprint);
                States.AddOrUpdate(
                    blueprint.Id,
                    _ =>
                    {
                        var runtime = new MobRuntimeState();
                        runtime.ConfigureForBlueprint(blueprint, reset: true);
                        return runtime;
                    },
                    (_, existing) =>
                    {
                        lock (existing)
                        {
                            existing.ConfigureForBlueprint(blueprint, reset: false);
                            return existing;
                        }
                    });
            }

            public static List<MobSnapshotDto> CreateSnapshotForChunk(ChunkData chunk)
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

            public static bool TryStrike(
                string mobId,
                double damage,
                string attackerId,
                out MobSnapshotDto? updated,
                out bool defeated,
                out string mobName)
            {
                updated = null;
                defeated = false;
                mobName = string.Empty;

                if (!Blueprints.TryGetValue(mobId, out var blueprint) || !States.TryGetValue(mobId, out var state))
                {
                    return false;
                }

                mobName = blueprint.Name;

                lock (state)
                {
                    if (!state.IsAlive)
                    {
                        updated = BuildSnapshot(mobId);
                        return true;
                    }

                    state.TargetPlayerId = attackerId;
                    state.Health = Math.Max(0, state.Health - Math.Max(1.0, damage));

                    if (state.Health <= double.Epsilon)
                    {
                        state.Health = 0;
                        state.IsAlive = false;
                        state.RespawnAt = DateTime.UtcNow.AddSeconds(MOB_RESPAWN_SECONDS);
                        state.TargetPlayerId = null;
                        defeated = true;
                    }
                }

                updated = BuildSnapshot(mobId);
                return true;
            }

            public static MobTickResult Tick(TimeSpan delta, IReadOnlyDictionary<string, PlayerObservation> players)
            {
                var result = new MobTickResult();
                var now = DateTime.UtcNow;
                var deltaSeconds = Math.Clamp(delta.TotalSeconds, 0.01, 0.5);

                foreach (var kvp in States)
                {
                    var mobId = kvp.Key;
                    var state = kvp.Value;
                    var changed = false;
                    Blueprints.TryGetValue(mobId, out var mobBlueprint);

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
                                var bestDistanceSq = MOB_AGGRO_RANGE * MOB_AGGRO_RANGE;
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
                                    var step = Math.Min(distance, MOB_MOVE_SPEED * deltaSeconds);
                                    state.X += dx / distance * step;
                                    state.Z += dz / distance * step;
                                    state.Heading = Math.Atan2(dx, dz);
                                    state.Y = SampleTerrainHeight(state.X, state.Z) + state.HeightOffset;
                                    changed = true;
                                }

                                if (distance > MOB_AGGRO_RANGE * 1.35)
                                {
                                    state.TargetPlayerId = null;
                                }
                                else if (distance <= MOB_ATTACK_RANGE + 0.1 && state.AttackCooldown <= 0)
                                {
                                    state.AttackCooldown = MOB_ATTACK_COOLDOWN;
                                    result.Attacks.Add(new MobAttackEvent
                                    {
                                        MobId = mobId,
                                        PlayerId = target.PlayerId,
                                        Damage = MOB_ATTACK_DAMAGE,
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
                                    var step = Math.Min(distance, MOB_MOVE_SPEED * 0.6 * deltaSeconds);
                                    state.X += dx / distance * step;
                                    state.Z += dz / distance * step;
                                    state.Heading = Math.Atan2(dx, dz);
                                    state.Y = SampleTerrainHeight(state.X, state.Z) + state.HeightOffset;
                                    changed = true;
                                }
                                else
                                {
                                    state.X = state.SpawnX;
                                    state.Z = state.SpawnZ;
                                    state.Y = state.SpawnY;
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

            private static MobSnapshotDto? BuildSnapshot(string mobId)
            {
                if (!Blueprints.TryGetValue(mobId, out var blueprint) || !States.TryGetValue(mobId, out var state))
                {
                    return null;
                }

                lock (state)
                {
                    var healthFraction = state.MaxHealth > 0
                        ? Math.Clamp(state.Health / state.MaxHealth, 0, 1)
                        : 0;

                    return new MobSnapshotDto
                    {
                        Id = blueprint.Id,
                        ChunkX = blueprint.ChunkX,
                        ChunkZ = blueprint.ChunkZ,
                        Type = blueprint.Type,
                        Name = blueprint.Name,
                        X = state.X,
                        Y = state.Y,
                        Z = state.Z,
                        Heading = state.Heading,
                        IsAlive = state.IsAlive,
                        HealthFraction = healthFraction
                    };
                }
            }

            internal sealed class MobTickResult
            {
                public List<MobSnapshotDto> Updates { get; } = new();
                public List<MobAttackEvent> Attacks { get; } = new();
            }

            internal sealed class MobAttackEvent
            {
                public string MobId { get; set; } = string.Empty;
                public string PlayerId { get; set; } = string.Empty;
                public double Damage { get; set; }
                public string MobName { get; set; } = string.Empty;
            }

            private sealed class MobRuntimeState
            {
                public double SpawnX { get; private set; }
                public double SpawnY { get; private set; }
                public double SpawnZ { get; private set; }
                public double HeightOffset { get; private set; } = 1.1;
                public double X { get; set; }
                public double Y { get; set; }
                public double Z { get; set; }
                public double Heading { get; set; }
                public double MaxHealth { get; private set; } = MOB_BASE_HEALTH;
                public double Health { get; set; } = MOB_BASE_HEALTH;
                public bool IsAlive { get; set; } = true;
                public DateTime? RespawnAt { get; set; }
                public string? TargetPlayerId { get; set; }
                public double AttackCooldown { get; set; }

                public void ConfigureForBlueprint(MobBlueprint blueprint, bool reset)
                {
                    SpawnX = blueprint.X;
                    SpawnZ = blueprint.Z;
                    SpawnY = blueprint.Y + HeightOffset;
                    MaxHealth = MOB_BASE_HEALTH;

                    if (reset)
                    {
                        X = SpawnX;
                        Y = SpawnY;
                        Z = SpawnZ;
                        Heading = 0;
                        Health = MaxHealth;
                        IsAlive = true;
                        RespawnAt = null;
                        TargetPlayerId = null;
                        AttackCooldown = 0;
                    }
                    else
                    {
                        Y = Math.Max(Y, SpawnY);
                        Health = Math.Clamp(Health, 0, MaxHealth);
                        if (!IsAlive && !RespawnAt.HasValue)
                        {
                            RespawnAt = DateTime.UtcNow.AddSeconds(MOB_RESPAWN_SECONDS);
                        }
                    }
                }
            }
        }
    }
}
