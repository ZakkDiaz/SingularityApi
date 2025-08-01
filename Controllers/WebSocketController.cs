using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace SingularityApi.Controllers
{
    public static class WebSocketController
    {
        // Cache chunk data so we don’t regenerate each time
        private static readonly Dictionary<(int, int), List<Vertex>> ChunkCache =
            new Dictionary<(int, int), List<Vertex>>();

        // Track each player’s position
        private static readonly Dictionary<string, PlayerState> Players =
            new Dictionary<string, PlayerState>();

        // Example generation settings
        private const int CHUNK_SIZE = 16;

        public static async Task HandleWebsocket(this HttpContext context)
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = 400;
                return;
            }

            using var webSocket = await context.WebSockets.AcceptWebSocketAsync();
            var connectionId = Guid.NewGuid().ToString();
            Console.WriteLine($"WebSocket connected! ID: {connectionId}");

            // Initialize the player at (0,0)
            Players[connectionId] = new PlayerState { X = 0, Y = 0, Z = 0 };

            var buffer = new byte[1024 * 8];
            var cancel = context.RequestAborted;

            while (!cancel.IsCancellationRequested && webSocket.State == WebSocketState.Open)
            {
                var result = await webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), cancel);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    Console.WriteLine($"Client {connectionId} closed connection.");
                    await webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "", cancel);
                    Players.Remove(connectionId);
                    break;
                }

                var clientMsg = Encoding.UTF8.GetString(buffer, 0, result.Count);
                try
                {
                    var jsonDoc = JsonDocument.Parse(clientMsg);
                    var root = jsonDoc.RootElement;
                    var msgType = root.GetProperty("type").GetString();

                    switch (msgType)
                    {
                        case "playerMove":
                            {
                                // parse dx, dz
                                double dx = root.GetProperty("dx").GetDouble();
                                double dz = root.GetProperty("dz").GetDouble();

                                // optionally parse y from client if present
                                double? clientY = null;
                                if (root.TryGetProperty("y", out var yElement)
                                    && yElement.ValueKind == JsonValueKind.Number)
                                {
                                    clientY = yElement.GetDouble();
                                }

                                if (Players.TryGetValue(connectionId, out var state))
                                {
                                    // update X,Z from dx, dz
                                    state.X += dx;
                                    state.Z += dz;

                                    // Error tolerance for Y
                                    if (clientY.HasValue)
                                    {
                                        double tolerance = 0.5; // allow up to 0.5 difference
                                        double diff = Math.Abs(clientY.Value - state.Y);

                                        if (diff < tolerance)
                                        {
                                            // accept client’s y
                                            state.Y = clientY.Value;
                                        }
                                        else
                                        {
                                            // keep server’s Y 
                                            // (or do partial approach, e.g. state.Y = Lerp(...))
                                        }
                                    }

                                    // Respond with updated authoritative position
                                    var moveResp = JsonSerializer.Serialize(new
                                    {
                                        type = "playerUpdate",
                                        x = state.X,
                                        y = state.Y,
                                        z = state.Z
                                    });
                                    await webSocket.SendAsync(
                                        new ArraySegment<byte>(Encoding.UTF8.GetBytes(moveResp)),
                                        WebSocketMessageType.Text,
                                        true,
                                        cancel
                                    );
                                }
                                break;
                            }

                        case "requestNearbyChunks":
                            {
                                int radius = 1;
                                if (root.TryGetProperty("radius", out var rProp))
                                    radius = rProp.GetInt32();

                                if (Players.TryGetValue(connectionId, out var state))
                                {
                                    int chunkX = (int)Math.Floor(state.X / CHUNK_SIZE);
                                    int chunkZ = (int)Math.Floor(state.Z / CHUNK_SIZE);

                                    var chunkResponses = new List<object>();

                                    for (int cx = chunkX - radius; cx <= chunkX + radius; cx++)
                                    {
                                        for (int cz = chunkZ - radius; cz <= chunkZ + radius; cz++)
                                        {
                                            var verts = GetOrGenerateChunk(cx, cz);
                                            chunkResponses.Add(new
                                            {
                                                x = cx,
                                                z = cz,
                                                vertices = verts
                                            });
                                        }
                                    }

                                    var msgOut = JsonSerializer.Serialize(new
                                    {
                                        type = "nearbyChunksResponse",
                                        centerChunkX = chunkX,
                                        centerChunkZ = chunkZ,
                                        chunkSize = CHUNK_SIZE,
                                        chunks = chunkResponses
                                    });
                                    await webSocket.SendAsync(
                                        new ArraySegment<byte>(Encoding.UTF8.GetBytes(msgOut)),
                                        WebSocketMessageType.Text,
                                        true,
                                        cancel
                                    );
                                }
                                break;
                            }

                        default:
                            Console.WriteLine($"Unknown message: {msgType}");
                            break;
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Error parsing message from {connectionId}: {ex.Message}");
                }
            }
        }

        // player state
        private class PlayerState
        {
            public double X { get; set; }
            public double Y { get; set; }
            public double Z { get; set; }
        }

        // chunk vertex
        public class Vertex
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        private static List<Vertex> GetOrGenerateChunk(int cx, int cz)
        {
            if (ChunkCache.TryGetValue((cx, cz), out var existing))
                return existing;

            var list = new List<Vertex>((CHUNK_SIZE + 1) * (CHUNK_SIZE + 1));

            // Example parameters for layered Perlin
            int octaves = 5;
            double persistence = 0.5;
            double baseFreq = 0.01;
            double baseAmp = 8.0; // how tall the terrain can get, for example

            for (int z = 0; z <= CHUNK_SIZE; z++)
            {
                for (int x = 0; x <= CHUNK_SIZE; x++)
                {
                    double worldX = cx * CHUNK_SIZE + x;
                    double worldZ = cz * CHUNK_SIZE + z;

                    // We pass world coords into layered Perlin
                    double h = LayeredPerlin2D(worldX, worldZ, octaves, persistence, baseFreq, baseAmp);

                    // optional: shift from [-some..some] to [0..someLarge]
                    // if Noise2D is ~[-1..1], and we do 5 octaves, total might be in e.g. [-someVal..someVal].
                    // If you want to ensure no negative: do e.g. h = (h+someOffset).
                    // Or just accept negative as "below sea level" if you want water.

                    list.Add(new Vertex
                    {
                        x = worldX,
                        y = h,
                        z = worldZ
                    });
                }
            }

            ChunkCache[(cx, cz)] = list;
            return list;
        }

        private static double LayeredPerlin2D(double x, double y, int octaves,
                                      double persistence,
                                      double baseFrequency,
                                      double baseAmplitude)
        {
            double total = 0;
            double frequency = baseFrequency;
            double amplitude = baseAmplitude;

            for (int i = 0; i < octaves; i++)
            {
                double noiseValue = Perlin.Noise2D(x * frequency, y * frequency);
                // noiseValue is ~[-1..1]. 
                // scale it by amplitude
                total += noiseValue * amplitude;

                frequency *= 2.0;      // next octave: double freq
                amplitude *= persistence; // reduce amplitude
            }

            return total;
        }
    }
}
