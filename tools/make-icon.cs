using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

class MakeIcon
{
    static void Main(string[] args)
    {
        string dir = args.Length > 0 ? args[0] : "media";
        int[] sizes = new int[] { 16, 20, 24, 32, 48, 64, 256 };
        byte[][] pngs = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++) pngs[i] = Png(Draw(sizes[i]));
        File.WriteAllBytes(Path.Combine(dir, "toolkit-256.png"), pngs[pngs.Length - 1]);
        string ico = Path.Combine(dir, "toolkit.ico");
        WriteIco(ico, sizes, pngs);
        Directory.CreateDirectory("native");
        File.Copy(ico, Path.Combine("native", "toolkit.ico"), true);
    }

    static Bitmap Draw(int size)
    {
        Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.Clear(Color.Transparent);
            float pad = Math.Max(1f, size * 0.04f);
            float radius = size * 0.23f;
            RectangleF box = new RectangleF(pad, pad, size - pad * 2f, size - pad * 2f);
            using (GraphicsPath path = Round(box, radius))
            using (Brush fill = new SolidBrush(Color.FromArgb(255, 20, 20, 20)))
                graphics.FillPath(fill, path);
            float u = size / 24f;
            PointF[] arrow = new PointF[] {
                new PointF(7.15f * u, 6.15f * u),
                new PointF(17.05f * u, 11.15f * u),
                new PointF(12.65f * u, 12.45f * u),
                new PointF(15.25f * u, 18.05f * u),
                new PointF(13.15f * u, 18.95f * u),
                new PointF(10.5f * u, 13.25f * u),
                new PointF(7.45f * u, 15.35f * u)
            };
            using (Brush mark = new SolidBrush(Color.FromArgb(255, 244, 244, 244)))
                graphics.FillPolygon(mark, arrow);
        }
        return bitmap;
    }

    static GraphicsPath Round(RectangleF box, float radius)
    {
        float d = Math.Min(radius * 2f, Math.Min(box.Width, box.Height));
        GraphicsPath path = new GraphicsPath();
        path.AddArc(box.X, box.Y, d, d, 180, 90);
        path.AddArc(box.Right - d, box.Y, d, d, 270, 90);
        path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90);
        path.AddArc(box.X, box.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    static byte[] Png(Bitmap bitmap)
    {
        using (MemoryStream stream = new MemoryStream())
        {
            bitmap.Save(stream, ImageFormat.Png);
            bitmap.Dispose();
            return stream.ToArray();
        }
    }

    static void WriteIco(string path, int[] sizes, byte[][] pngs)
    {
        using (FileStream stream = File.Create(path))
        using (BinaryWriter writer = new BinaryWriter(stream))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)sizes.Length);
            int offset = 6 + 16 * sizes.Length;
            for (int i = 0; i < sizes.Length; i++)
            {
                int side = sizes[i] >= 256 ? 0 : sizes[i];
                writer.Write((byte)side);
                writer.Write((byte)side);
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write(pngs[i].Length);
                writer.Write(offset);
                offset += pngs[i].Length;
            }
            for (int i = 0; i < pngs.Length; i++) writer.Write(pngs[i]);
        }
    }
}
