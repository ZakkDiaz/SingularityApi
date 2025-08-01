using Microsoft.AspNetCore.Mvc;

namespace SingularityApi.Controllers
{
    [ApiController]
    [Route("[controller]")]
    public class GameController : Controller
    {
        [HttpGet]
        public IActionResult Index()
        {
            return Ok(new object() { });
        }
    }
}
