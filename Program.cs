using System.Net.WebSockets;
using System.Text.Json;
using System.Text;
using SingularityApi.Controllers;

namespace SingularityApi
{
    public class Program
    {
        public static void Main(string[] args)
        {
            var builder = WebApplication.CreateBuilder(args);

            // Add services to the container.

            builder.Services.AddControllers();

            var app = builder.Build();

            // Configure the HTTP request pipeline.
            app.UseFileServer();



            app.UseHttpsRedirection();

            app.UseAuthorization();


            app.MapControllers();

            // 1. Serve static files from wwwroot
            app.UseDefaultFiles();  // If you want index.html to load at root
            app.UseStaticFiles();

            // 2. Enable WebSockets
            app.UseWebSockets();


            // 3. Map a WebSocket endpoint at /ws
            app.Map("/ws", WebSocketController.HandleWebsocket);

            app.Run();
        }
    }
}
