using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Singularity.Core;
using System.Linq;

namespace SingularityApi.Controllers;

public static class WebSocketController
{
    private static readonly GameWorld World = new();
    private static readonly ConcurrentDictionary<string, WebSocket> Connections = new();
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    static WebSocketController()
    {
        World.WorldTicked += OnWorldTicked;
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

        var playerState = World.AddPlayer(connectionId);

        await SendInitialStateAsync(webSocket, connectionId, context.RequestAborted);
        await BroadcastJsonAsync(new { type = "playerJoined", player = World.CreatePlayerSnapshot(playerState) }, connectionId);

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
            World.RemovePlayer(connectionId);
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

            case "upgradeStat":
                await HandleStatUpgradeAsync(connectionId, root);
                break;

            case "chooseClass":
                await HandleChooseClassAsync(connectionId, root);
                break;

            default:
                Console.WriteLine($"Unknown message type '{msgType}' from {connectionId}");
                break;
        }
    }

    private static async Task HandlePlayerTransformAsync(string connectionId, JsonElement root)
    {
        if (!World.TryGetPlayer(connectionId, out var state) || state is null)
        {
            return;
        }

        var playerState = state;

        if (!TryGetDouble(root, "x", out var x) ||
            !TryGetDouble(root, "y", out var y) ||
            !TryGetDouble(root, "z", out var z) ||
            !TryGetDouble(root, "heading", out var heading))
        {
            return;
        }

        TryGetDouble(root, "velocityX", out var velocityX);
        TryGetDouble(root, "velocityZ", out var velocityZ);

        if (!World.TryUpdatePlayerTransform(playerState, x, y, z, heading, velocityX, velocityZ, out var snapshot) || snapshot == null)
        {
            return;
        }

        await BroadcastPlayerStateAsync(snapshot);
    }

    private static async Task HandleChunkRequestAsync(string connectionId, WebSocket socket, JsonElement root, CancellationToken cancel)
    {
        if (!World.TryGetPlayer(connectionId, out var state) || state is null)
        {
            return;
        }

        var playerState = state;

        var radius = 1;
        if (root.TryGetProperty("radius", out var radiusProp) && radiusProp.ValueKind == JsonValueKind.Number)
        {
            radius = Math.Clamp(radiusProp.GetInt32(), 1, 4);
        }

        var chunkResult = World.GetNearbyChunks(playerState, radius);
        var chunks = chunkResult.Chunks.Select(chunk => new
        {
            x = chunk.X,
            z = chunk.Z,
            vertices = chunk.Vertices,
            environmentObjects = chunk.EnvironmentObjects,
            mobs = chunk.Mobs
        }).ToList();

        var payload = new
        {
            type = "nearbyChunksResponse",
            centerChunkX = chunkResult.CenterChunkX,
            centerChunkZ = chunkResult.CenterChunkZ,
            chunkSize = chunkResult.ChunkSize,
            chunks
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

    private static async Task HandleStatUpgradeAsync(string playerId, JsonElement root)
    {
        if (!root.TryGetProperty("statId", out var statProp) || statProp.ValueKind != JsonValueKind.String)
        {
            return;
        }

        var statId = statProp.GetString();
        if (string.IsNullOrWhiteSpace(statId))
        {
            return;
        }

        var update = World.ApplyStatUpgrade(playerId, statId, DateTime.UtcNow);
        if (update != null)
        {
            await SendPlayerStatsAsync(update);
        }
    }

    private static async Task HandleChooseClassAsync(string playerId, JsonElement root)
    {
        if (!root.TryGetProperty("classId", out var classProp) || classProp.ValueKind != JsonValueKind.String)
        {
            return;
        }

        var classId = classProp.GetString();
        if (string.IsNullOrWhiteSpace(classId))
        {
            return;
        }

        var update = World.SelectPlayerClass(playerId, classId, DateTime.UtcNow);
        if (update == null)
        {
            return;
        }

        await SendPlayerStatsAsync(update);
        await BroadcastPlayerStateAsync(World.CreatePlayerSnapshot(update.Player));
        await BroadcastJsonAsync(new { type = "playerClassChanged", playerId, classId = update.Snapshot.ClassId });
    }

    private static async Task ExecuteAbilityAsync(string playerId, string abilityId, string? targetId)
    {
        var now = DateTime.UtcNow;
        var result = World.ExecuteAbility(playerId, abilityId, targetId, now);

        foreach (var update in result.PlayerUpdates)
        {
            await SendPlayerStatsAsync(update);
        }

        if (!result.AbilityTriggered)
        {
            return;
        }

        await BroadcastJsonAsync(new { type = "playerAbility", playerId, abilityId = result.AbilityId, targetId, attack = result.AttackSpawn });

        if (result.MobUpdate != null)
        {
            await BroadcastJsonAsync(new { type = "mobUpdate", mobs = new[] { result.MobUpdate } });
        }

        if (result.EnvironmentUpdate != null)
        {
            await BroadcastJsonAsync(new { type = "environmentUpdate", environmentObject = result.EnvironmentUpdate });
        }
    }

    private static async Task SendInitialStateAsync(WebSocket socket, string connectionId, CancellationToken cancel)
    {
        var otherPlayers = World.Players.Values
            .Where(p => p.Id != connectionId)
            .Select(World.CreatePlayerSnapshot)
            .ToList();

        PlayerStatsDto? statsSnapshot = null;
        List<AbilityDto>? abilitySnapshots = null;
        IReadOnlyList<PlayerStatUpgradeOption>? upgradeOptions = null;
        if (World.TryGetPlayer(connectionId, out var playerState) && playerState is { } current)
        {
            statsSnapshot = World.BuildStatsSnapshot(current);
            abilitySnapshots = World.BuildAbilitySnapshots(current);
            if (statsSnapshot.UnspentStatPoints > 0)
            {
                upgradeOptions = World.StatUpgradeDefinitions;
            }
        }

        var classSummaries = World.BuildClassSummaries();

        var payload = new
        {
            type = "initialState",
            playerId = connectionId,
            worldSeed = World.Options.WorldSeed,
            timeOfDay = World.GetTimeOfDayFraction(),
            players = otherPlayers,
            stats = statsSnapshot,
            abilities = abilitySnapshots,
            upgradeOptions,
            classes = classSummaries
        };

        await SendJsonAsync(socket, payload, cancel);
    }

    private static async void OnWorldTicked(object? sender, WorldTickEventArgs eventArgs)
    {
        try
        {
            if (eventArgs.EnvironmentUpdates.Count > 0)
            {
                foreach (var obj in eventArgs.EnvironmentUpdates)
                {
                    await BroadcastJsonAsync(new { type = "environmentUpdate", environmentObject = obj });
                }
            }

            if (eventArgs.MobUpdates.Count > 0)
            {
                await BroadcastJsonAsync(new { type = "mobUpdate", mobs = eventArgs.MobUpdates });
            }

            foreach (var attack in eventArgs.MobAttacks)
            {
                await BroadcastJsonAsync(new { type = "mobAttack", mobId = attack.MobId, targetId = attack.PlayerId });
            }

            foreach (var stats in eventArgs.PlayerStatUpdates)
            {
                await SendPlayerStatsAsync(stats);
            }

            foreach (var respawn in eventArgs.PlayerRespawns)
            {
                await BroadcastPlayerStateAsync(respawn.Snapshot);
                await SendPlayerStatsAsync(respawn.StatsUpdate);
            }

            await BroadcastJsonAsync(new
            {
                type = "worldTick",
                timeOfDay = eventArgs.TimeOfDay,
                attacks = eventArgs.AttackSnapshots,
                completedAttackIds = eventArgs.CompletedAttackIds
            });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error while broadcasting world tick: {ex.Message}");
        }
    }

    private static Task BroadcastPlayerStateAsync(PlayerSnapshot snapshot)
    {
        return BroadcastJsonAsync(new { type = "playerState", player = snapshot });
    }

    private static async Task SendPlayerStatsAsync(PlayerStatsUpdate update)
    {
        if (!Connections.TryGetValue(update.Player.Id, out var socket) || socket.State != WebSocketState.Open)
        {
            return;
        }

        var payload = new
        {
            type = "playerStats",
            stats = update.Snapshot,
            xpAwarded = update.ExperienceAwarded,
            leveledUp = update.LeveledUp,
            reason = update.Reason,
            abilities = update.Abilities,
            upgradeOptions = update.UpgradeOptions
        };

        await SendJsonAsync(socket, payload, CancellationToken.None);
    }

    private static async Task SendJsonAsync(WebSocket socket, object payload, CancellationToken cancel)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        var buffer = Encoding.UTF8.GetBytes(json);
        await socket.SendAsync(new ArraySegment<byte>(buffer), WebSocketMessageType.Text, true, cancel);
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
            World.RemovePlayer(connectionId);
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
}
