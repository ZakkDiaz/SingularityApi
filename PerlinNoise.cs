using System;

public static class Perlin
{
    // A standard permutation table of size 256, repeated twice for indexing
    private static readonly int[] perm = {
        151,160,137,91,90,15,
        131,13,201,95,96,53,194,233,7,225,140,36,103,30,
        69,142,8,99,37,240,21,10,23,190,  6,148,247,120,
        234,75,  0,26,197,62,94,252,219,203,117, 35, 11,
         32, 57,177, 33, 88,237,149, 56, 87,174, 20,125,
        136,171,168, 68,175, 74,165, 71,134,139, 48, 27,
        166, 77,146,158,231, 83,111,229,122,60,211,133,
        230,220,105, 92, 41, 55, 46,245, 40,244,102,143,
         54, 65, 25, 63,161,  1,216, 80, 73,209, 76,132,
        187,208, 89, 18,169,200,196,135,130,116,188,159,
         86,164,100,109,198,173,186,  3, 64, 52,217,226,
         250,124,123,  5,202, 38,147,118,126,255, 82, 85,
        212,207,206, 59,227, 47, 16, 58, 17,182,189, 28,
        42,223,183,170,213,119,248,152,  2, 44,154,163,
         70,221,153,101,155,167,  43,172,  9,129, 22, 39,
         253, 19, 98,108,110, 79,113,224,232,178,185, 112,
        104,218,246,97,228,251, 34,242,193,238,210,144,
         12,191,179,162,241, 81, 51,145,235,249, 14,239,
         107, 49,192,214,  31,181,199,106,157,184, 84,204,
         176,115,121, 50, 45,127,  4,150,254, 138,236,205,
        93,222,114, 67, 29, 24, 72,243,141,128,195, 78,
         66,215, 61,156,180
        // The above is 256 values, repeated:
        ,151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,
        69,142,8,99,37,240,21,10,23,190,  6,148,247,120,
        234,75,  0,26,197,62,94,252,219,203,117, 35, 11,
         32, 57,177, 33, 88,237,149, 56, 87,174, 20,125,
        136,171,168, 68,175, 74,165, 71,134,139, 48, 27,
        166, 77,146,158,231, 83,111,229,122,60,211,133,
        230,220,105, 92, 41, 55, 46,245, 40,244,102,143,
         54, 65, 25, 63,161,  1,216, 80, 73,209, 76,132,
        187,208, 89, 18,169,200,196,135,130,116,188,159,
         86,164,100,109,198,173,186,  3, 64, 52,217,226,
         250,124,123,  5,202, 38,147,118,126,255, 82, 85,
        212,207,206, 59,227, 47, 16, 58, 17,182,189, 28,
        42,223,183,170,213,119,248,152,  2, 44,154,163,
         70,221,153,101,155,167,  43,172,  9,129, 22, 39,
         253, 19, 98,108,110, 79,113,224,232,178,185, 112,
        104,218,246,97,228,251, 34,242,193,238,210,144,
         12,191,179,162,241, 81, 51,145,235,249, 14,239,
         107, 49,192,214,  31,181,199,106,157,184, 84,204,
         176,115,121, 50, 45,127,  4,150,254, 138,236,205,
        93,222,114, 67, 29, 24, 72,243,141,128,195, 78,
         66,215, 61,156,180
    };

    // Fade polynomial: 6t^5 - 15t^4 + 10t^3
    private static double Fade(double t)
    {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    // Linear interpolation
    private static double Lerp(double a, double b, double t)
    {
        return a + t * (b - a);
    }

    // 2D gradient. The "hash" picks a gradient direction.
    private static double Grad(int hash, double x, double y)
    {
        // Convert low 2 bits of hash code into 4 gradient directions
        int h = hash & 3;
        double u = (h < 2) ? x : y;
        double v = (h < 1 || h == 2) ? y : x;
        // h & 1 decides if u is positive or negative
        // h & 2 decides if v is positive or negative
        double result = ((h & 1) == 0 ? u : -u) + ((h & 2) == 0 ? v : -v);
        return result;
    }

    /// <summary>
    /// 2D Perlin noise function. Returns ~[-1..1].
    /// </summary>
    public static double Noise2D(double x, double y)
    {
        // Floor the coordinates
        int X = (int)Math.Floor(x) & 255;
        int Y = (int)Math.Floor(y) & 255;

        // Relative coords within the cell
        double xf = x - Math.Floor(x);
        double yf = y - Math.Floor(y);

        // Indexes in the perm table
        int A = (perm[X] + Y) & 255;
        int B = (perm[X + 1] + Y) & 255;

        // Note: We do fade on xf, yf
        double u = Fade(xf);
        double v = Fade(yf);

        // Hash coordinates to get gradient indexes
        int AA = perm[A] & 255;
        int AB = perm[A + 1] & 255;
        int BA = perm[B] & 255;
        int BB = perm[B + 1] & 255;

        // Grad/perlin
        double x1 = Lerp(
            Grad(AA, xf, yf),
            Grad(BA, xf - 1, yf),
            u
        );
        double x2 = Lerp(
            Grad(AB, xf, yf - 1),
            Grad(BB, xf - 1, yf - 1),
            u
        );
        return Lerp(x1, x2, v); // final interpolation
    }
}
