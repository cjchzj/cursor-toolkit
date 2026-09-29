using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace CursorToolkit
{
    internal static class Program
    {
        const int WH_KEYBOARD_LL = 13;
        const int WM_KEYDOWN = 0x0100;
        const int WM_SYSKEYDOWN = 0x0104;
        const int WM_HOTKEY = 0x0312;
        const uint MOD_NOREPEAT = 0x4000;

        const string DragHint = "\u62d6\u62fd\u9009\u62e9\uff0c\u677e\u5f00\u540e\u53ef\u8c03\u6574";
        const string ScrollTitle = "\u6eda\u52a8\u622a\u56fe";
        const string ScrollHint = "Esc \u5b8c\u6210";
        const string TooSmall = "\u9009\u533a\u592a\u5c0f";

        static IntPtr hotkeyWindow;
        static IntPtr hook;
        static LowLevelProc hookProc;
        static int phase;
        static volatile bool finishScroll;
        static int ignoreEscUntil;
        static OverlayForm captureUi;
        static readonly List<int> hotkeyIds = new List<int>();
        static Process edgeProcess;
        static IntPtr edgeHwnd;

        [STAThread]
        static void Main(string[] args)
        {
            EnableDpi();
            string mode = "serve";
            string capture = "region";
            string outDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyPictures), "CursorToolkit");
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--serve") mode = "serve";
                else if (arg == "--capture" && i + 1 < args.Length)
                {
                    mode = "capture";
                    capture = args[++i];
                }
                else if (arg.StartsWith("--out-dir=")) outDir = arg.Substring("--out-dir=".Length);
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                if (mode == "capture") RunCapture(capture, outDir);
                else RunServe();
            }
            catch (Exception ex)
            {
                CaptureLog("crash " + ex.Message);
                Emit("{\"ok\":false,\"type\":\"error\",\"error\":" + Quote(ex.Message) + "}");
            }
        }

        static void RunServe()
        {
            HotkeyForm form = new HotkeyForm();
            hotkeyWindow = form.Handle;
            ReadStdin(form);
            Emit("{\"type\":\"ready\"}");
            Application.Run(form);
        }

        static void RunCapture(string mode, string outDir)
        {
            try
            {
                File.WriteAllText(Path.Combine(Path.GetTempPath(), "ctk-capture.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff") + " start " + mode + Environment.NewLine);
            }
            catch { }
            InstallEsc();
            try
            {
                Rectangle selected;
                string action;
                if (!Select(out selected, out action))
                {
                    Emit("{\"ok\":false,\"error\":" + Quote("\u5df2\u53d6\u6d88") + "}");
                    return;
                }
                selected = ClampToVirtual(selected);
                if (selected.Width < 8 || selected.Height < 8)
                {
                    Emit("{\"ok\":false,\"error\":" + Quote(TooSmall) + "}");
                    return;
                }
                Bitmap bitmap = action == "scroll" ? ScrollCapture(selected) : CaptureRect(selected);
                if (bitmap == null)
                {
                    Emit("{\"ok\":false,\"error\":" + Quote("\u6ca1\u6709\u622a\u5230\u753b\u9762") + "}");
                    return;
                }
                try
                {
                    string file = action == "save"
                        ? SaveAsPng(bitmap)
                        : SavePng(bitmap, outDir);
                    if (string.IsNullOrEmpty(file))
                    {
                        Emit("{\"ok\":false,\"error\":" + Quote("\u5df2\u53d6\u6d88\u4fdd\u5b58") + "}");
                        return;
                    }
                    Emit("{\"ok\":true,\"path\":" + Quote(file) + "}");
                }
                finally
                {
                    bitmap.Dispose();
                }
            }
            finally
            {
                RestoreCursor();
                RemoveEsc();
            }
        }

        static void HandleLine(string line)
        {
            if (line == "QUIT")
            {
                CloseEdge();
                Application.Exit();
                return;
            }
            if (line.StartsWith("REBIND "))
            {
                Rebind(line.Substring(7));
                return;
            }
            if (line.StartsWith("TOGGLE "))
            {
                ToggleEdge(line.Substring(7).Trim());
                return;
            }
            if (line.StartsWith("WINDOW "))
            {
                WindowOp(line.Substring(7).Trim());
            }
        }

        static void HandleHotkey(int id)
        {
            string action = id == 1 ? "region" : id == 2 ? "scroll" : id == 3 ? "float" : "";
            if (action.Length == 0) return;
            Emit("{\"type\":\"hotkey\",\"action\":" + Quote(action) + "}");
        }

        static void Rebind(string json)
        {
            Unregister();
            Bind("region", Field(json, "region"), 1);
            Bind("scroll", Field(json, "scroll"), 2);
            Bind("float", Field(json, "float"), 3);
        }

        static void Bind(string action, string chord, int id)
        {
            if (string.IsNullOrEmpty(chord)) return;
            uint mods;
            uint vk;
            string error;
            if (!TryParse(chord, out mods, out vk, out error))
            {
                Emit("{\"type\":\"hotkey-error\",\"action\":" + Quote(action) + ",\"error\":" + Quote(error) + "}");
                return;
            }
            if (!RegisterHotKey(hotkeyWindow, id, mods | MOD_NOREPEAT, vk))
            {
                Emit("{\"type\":\"hotkey-error\",\"action\":" + Quote(action) + ",\"error\":" + Quote("\u5feb\u6377\u952e\u88ab\u5360\u7528") + "}");
                return;
            }
            hotkeyIds.Add(id);
        }

        static void Unregister()
        {
            for (int i = 0; i < hotkeyIds.Count; i++) UnregisterHotKey(hotkeyWindow, hotkeyIds[i]);
            hotkeyIds.Clear();
        }

        static void ToggleEdge(string url)
        {
            if (edgeProcess != null && !edgeProcess.HasExited)
            {
                CloseEdge();
                Emit("{\"type\":\"external\",\"open\":false}");
                return;
            }
            string edge = FindEdge();
            if (edge == null)
            {
                Emit("{\"type\":\"external\",\"open\":false,\"error\":" + Quote("\u6ca1\u6709\u627e\u5230 Edge") + "}");
                return;
            }
            string profile = Path.Combine(Path.GetTempPath(), "cursor-toolkit-float");
            Directory.CreateDirectory(profile);
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = edge;
            info.Arguments = "--app=" + url + " --new-window --window-size=400,680 --no-first-run --no-default-browser-check --user-data-dir=\"" + profile + "\"";
            info.UseShellExecute = false;
            edgeProcess = Process.Start(info);
            ThreadPool.QueueUserWorkItem(delegate
            {
                Process proc = edgeProcess;
                if (proc == null) return;
                for (int i = 0; i < 40; i++)
                {
                    try
                    {
                        proc.Refresh();
                        if (proc.HasExited) return;
                        if (proc.MainWindowHandle != IntPtr.Zero) break;
                    }
                    catch
                    {
                        return;
                    }
                    Thread.Sleep(100);
                }
                try
                {
                    int pid = proc.Id;
                    for (int k = 0; k < 24; k++)
                    {
                        StyleEdgeWindows(pid);
                        Thread.Sleep(k < 10 ? 120 : 250);
                        proc.Refresh();
                        if (proc.HasExited) return;
                    }
                }
                catch { }
                Emit("{\"type\":\"external\",\"open\":true}");
            });
        }

        static void CloseEdge()
        {
            Process proc = edgeProcess;
            edgeProcess = null;
            edgeHwnd = IntPtr.Zero;
            if (proc == null) return;
            try
            {
                if (!proc.HasExited) proc.Kill();
            }
            catch { }
        }

        static IntPtr EdgeWindow()
        {
            Process proc = edgeProcess;
            if (proc == null) return IntPtr.Zero;
            try
            {
                proc.Refresh();
                if (proc.HasExited) return IntPtr.Zero;
                if (proc.MainWindowHandle != IntPtr.Zero) edgeHwnd = proc.MainWindowHandle;
            }
            catch
            {
                return IntPtr.Zero;
            }
            return edgeHwnd;
        }

        static int styleTargetPid;
        static readonly EnumWindowsProc StyleEdgeCallback = StyleEdgeWindow;

        static void StyleEdgeWindows(int pid)
        {
            styleTargetPid = pid;
            EnumWindows(StyleEdgeCallback, IntPtr.Zero);
        }

        static bool StyleEdgeWindow(IntPtr hwnd, IntPtr extra)
        {
            uint windowPid;
            GetWindowThreadProcessId(hwnd, out windowPid);
            if ((int)windowPid != styleTargetPid || !IsWindowVisible(hwnd)) return true;
            edgeHwnd = hwnd;
            SetWindowText(hwnd, "\u5de5\u4f5c\u53f0");
            StyleChrome(hwnd);
            return true;
        }

        static void StyleChrome(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return;
            SetWindowText(hwnd, "\u5de5\u4f5c\u53f0");
            int dark = 1;
            DwmSetWindowAttribute(hwnd, 20, ref dark, sizeof(int));
            int chrome = 0x00141414;
            DwmSetWindowAttribute(hwnd, 34, ref chrome, sizeof(int));
            DwmSetWindowAttribute(hwnd, 35, ref chrome, sizeof(int));
            int ink = 0x00F0F0F0;
            DwmSetWindowAttribute(hwnd, 36, ref ink, sizeof(int));
            int ex = GetWindowLong(hwnd, -20);
            ex &= ~(0x00000100 | 0x00000200 | 0x00000001);
            SetWindowLong(hwnd, -20, ex);
            SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0020 | 0x0040);
        }

        static void WindowOp(string action)
        {
            IntPtr hwnd = EdgeWindow();
            if (hwnd == IntPtr.Zero && action != "close")
            {
                Emit("{\"type\":\"window\",\"ok\":false,\"error\":" + Quote("\u6ca1\u6709\u6253\u5f00\u7684\u5de5\u4f5c\u53f0") + "}");
                return;
            }
            bool maximized = false;
            if (action == "min") ShowWindow(hwnd, 6);
            else if (action == "max")
            {
                if (IsZoomed(hwnd)) ShowWindow(hwnd, 9);
                else ShowWindow(hwnd, 3);
            }
            else if (action == "close")
            {
                CloseEdge();
                Emit("{\"type\":\"external\",\"open\":false}");
                Emit("{\"type\":\"window\",\"ok\":true,\"action\":\"close\",\"maximized\":false}");
                return;
            }
            else if (action == "drag")
            {
                ReleaseCapture();
                SendMessage(hwnd, 0x00A1, new IntPtr(2), IntPtr.Zero);
            }
            else
            {
                Emit("{\"type\":\"window\",\"ok\":false,\"error\":" + Quote("\u672a\u77e5\u7a97\u53e3\u64cd\u4f5c") + "}");
                return;
            }
            try { maximized = hwnd != IntPtr.Zero && IsZoomed(hwnd); } catch { }
            Emit("{\"type\":\"window\",\"ok\":true,\"action\":" + Quote(action) + ",\"maximized\":" + (maximized ? "true" : "false") + "}");
        }

        static string FindEdge()
        {
            string[] paths = new string[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe")
            };
            for (int i = 0; i < paths.Length; i++)
            {
                if (File.Exists(paths[i])) return paths[i];
            }
            return null;
        }

        static bool Select(out Rectangle rect, out string action)
        {
            rect = Rectangle.Empty;
            action = "";
            phase = 1;
            ignoreEscUntil = Environment.TickCount + 1200;
            using (OverlayForm form = new OverlayForm())
            {
                captureUi = form;
                DialogResult result;
                try
                {
                    CaptureLog("show");
                    result = form.ShowDialog();
                    CaptureLog("result " + result + " accepted=" + form.Accepted);
                }
                finally
                {
                    captureUi = null;
                    phase = 0;
                }
                RestoreCursor();
                if (result != DialogResult.OK || !form.Accepted) return false;
                rect = form.Selected;
                action = form.Action;
                return true;
            }
        }

        static Bitmap ScrollCapture(Rectangle rect)
        {
            finishScroll = false;
            phase = 2;
            HudForm hud = new HudForm(rect);
            hud.Show();
            Pump(160);
            Bitmap last = CaptureRect(rect);
            if (last == null)
            {
                hud.Close();
                hud.Dispose();
                phase = 0;
                return null;
            }
            Bitmap stitched = (Bitmap)last.Clone();
            WinPoint cursor;
            GetCursorPos(out cursor);
            int stuck = 0;
            try
            {
                for (int slice = 1; slice <= 25; slice++)
                {
                    if (finishScroll) break;
                    hud.SetText(ScrollTitle + "  " + slice + "  \u00b7  " + ScrollHint);
                    ScrollDown(rect, 4);
                    Pump(280);
                    if (finishScroll) break;
                    Bitmap next = CaptureRect(rect);
                    if (next == null) break;
                    int dy = MeasureShift(last, next);
                    last.Dispose();
                    last = next;
                    if (dy < 8)
                    {
                        stuck++;
                        if (stuck >= 2) break;
                        continue;
                    }
                    stuck = 0;
                    Bitmap grown = AppendBottom(stitched, next, dy);
                    stitched.Dispose();
                    stitched = grown;
                    if (stitched.Height > 24000) break;
                }
            }
            finally
            {
                if (last != null) last.Dispose();
                hud.Close();
                hud.Dispose();
                SetCursorPos(cursor.X, cursor.Y);
                phase = 0;
            }
            return stitched;
        }

        static Bitmap CaptureRect(Rectangle rect)
        {
            if (rect.Width < 1 || rect.Height < 1) return null;
            Bitmap bitmap = new Bitmap(rect.Width, rect.Height, PixelFormat.Format24bppRgb);
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                graphics.CopyFromScreen(rect.Location, Point.Empty, rect.Size, CopyPixelOperation.SourceCopy);
            }
            return bitmap;
        }

        static Bitmap AppendBottom(Bitmap stitched, Bitmap frame, int dy)
        {
            int add = Math.Min(dy, frame.Height);
            Bitmap result = new Bitmap(stitched.Width, stitched.Height + add, PixelFormat.Format24bppRgb);
            using (Graphics graphics = Graphics.FromImage(result))
            {
                graphics.DrawImage(stitched, 0, 0);
                Rectangle dest = new Rectangle(0, stitched.Height, stitched.Width, add);
                Rectangle src = new Rectangle(0, frame.Height - add, frame.Width, add);
                graphics.DrawImage(frame, dest, src, GraphicsUnit.Pixel);
            }
            return result;
        }

        static int MeasureShift(Bitmap previous, Bitmap next)
        {
            int stride;
            int width;
            int height;
            int stride2;
            int width2;
            int height2;
            byte[] a = BytesOf(previous, out stride, out width, out height);
            byte[] b = BytesOf(next, out stride2, out width2, out height2);
            if (a == null || b == null || width != width2 || height != height2 || stride != stride2) return -1;
            int bestDy = -1;
            long best = long.MaxValue;
            int limit = height - 8;
            for (int dy = 8; dy <= limit; dy += 2)
            {
                long avg = Score(a, b, stride, width, height, dy, 4, 16);
                if (avg >= 0 && avg < best)
                {
                    best = avg;
                    bestDy = dy;
                }
            }
            if (bestDy < 0 || best > 28) return -1;
            int from = Math.Max(8, bestDy - 2);
            int to = Math.Min(limit, bestDy + 2);
            for (int dy = from; dy <= to; dy++)
            {
                long avg = Score(a, b, stride, width, height, dy, 3, 10);
                if (avg >= 0 && avg < best)
                {
                    best = avg;
                    bestDy = dy;
                }
            }
            if (best > 28) return -1;
            return bestDy;
        }

        static long Score(byte[] a, byte[] b, int stride, int width, int height, int dy, int stepY, int stepX)
        {
            long score = 0;
            int samples = 0;
            int maxX = width - 4;
            for (int y = dy; y < height; y += stepY)
            {
                int rowA = y * stride;
                int rowB = (y - dy) * stride;
                for (int x = 4; x < maxX; x += stepX)
                {
                    int i1 = rowA + x * 3;
                    int i2 = rowB + x * 3;
                    if (i1 + 2 >= a.Length || i2 + 2 >= b.Length) continue;
                    score += Math.Abs(a[i1] - b[i2]) + Math.Abs(a[i1 + 1] - b[i2 + 1]) + Math.Abs(a[i1 + 2] - b[i2 + 2]);
                    samples++;
                }
            }
            if (samples == 0) return -1;
            return score / samples;
        }

        static byte[] BytesOf(Bitmap bmp, out int stride, out int width, out int height)
        {
            width = bmp.Width;
            height = bmp.Height;
            stride = 0;
            BitmapData data = bmp.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                stride = Math.Abs(data.Stride);
                byte[] bytes = new byte[stride * height];
                Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
                return bytes;
            }
            finally
            {
                bmp.UnlockBits(data);
            }
        }

        static void ScrollDown(Rectangle rect, int notches)
        {
            int x = rect.X + rect.Width / 2;
            int y = rect.Y + Math.Max(24, rect.Height / 2);
            SetCursorPos(x, y);
            WinPoint point = new WinPoint();
            point.X = x;
            point.Y = y;
            IntPtr target = WindowFromPoint(point);
            IntPtr root = GetAncestor(target, 2);
            if (root == IntPtr.Zero) root = target;
            if (root != IntPtr.Zero) SetForegroundWindow(root);
            int delta = -120 * notches;
            IntPtr wheel = (IntPtr)(delta << 16);
            IntPtr where = (IntPtr)((y << 16) | (x & 0xFFFF));
            IntPtr cursor = target;
            for (int i = 0; cursor != IntPtr.Zero && i < 8; i++)
            {
                PostMessage(cursor, 0x020A, wheel, where);
                IntPtr parent = GetParent(cursor);
                if (parent == IntPtr.Zero || parent == cursor) break;
                cursor = parent;
            }
            mouse_event(0x0800, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
        }

        static void Pump(int milliseconds)
        {
            int end = Environment.TickCount + milliseconds;
            while (unchecked(Environment.TickCount - end) < 0)
            {
                Application.DoEvents();
                if (finishScroll) return;
                Thread.Sleep(15);
            }
        }

        static string SavePng(Bitmap bitmap, string dir)
        {
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png");
            bitmap.Save(file, ImageFormat.Png);
            try { Clipboard.SetImage(bitmap); } catch { }
            return file;
        }

        static string SaveAsPng(Bitmap bitmap)
        {
            using (SaveFileDialog dialog = new SaveFileDialog())
            {
                dialog.Title = "\u4fdd\u5b58\u622a\u56fe";
                dialog.Filter = "PNG \u56fe\u7247|*.png";
                dialog.DefaultExt = "png";
                dialog.AddExtension = true;
                dialog.FileName = "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png";
                if (dialog.ShowDialog() != DialogResult.OK) return "";
                bitmap.Save(dialog.FileName, ImageFormat.Png);
                return dialog.FileName;
            }
        }

        static Rectangle ClampToVirtual(Rectangle rect)
        {
            Rectangle screen = SystemInformation.VirtualScreen;
            int x = Math.Max(rect.X, screen.X);
            int y = Math.Max(rect.Y, screen.Y);
            int right = Math.Min(rect.Right, screen.Right);
            int bottom = Math.Min(rect.Bottom, screen.Bottom);
            if (right <= x || bottom <= y) return Rectangle.Empty;
            return new Rectangle(x, y, right - x, bottom - y);
        }

        static GraphicsPath Round(Rectangle bounds, int radius)
        {
            int d = Math.Max(1, radius) * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        static Rectangle Normalize(Point a, Point b)
        {
            int x = Math.Min(a.X, b.X);
            int y = Math.Min(a.Y, b.Y);
            return new Rectangle(x, y, Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
        }

        static void InstallEsc()
        {
            hookProc = new LowLevelProc(EscHook);
            hook = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, IntPtr.Zero, 0);
            if (hook == IntPtr.Zero) hook = SetWindowsHookEx(WH_KEYBOARD_LL, hookProc, GetModuleHandle(null), 0);
        }

        static void RemoveEsc()
        {
            if (hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(hook);
                hook = IntPtr.Zero;
            }
        }

        static IntPtr EscHook(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0 && (wParam == (IntPtr)WM_KEYDOWN || wParam == (IntPtr)WM_SYSKEYDOWN))
            {
                int vk = Marshal.ReadInt32(lParam);
                if (vk == 0x1B)
                {
                    if (phase == 2) finishScroll = true;
                    else if (phase == 1 && EscIsSafe())
                    {
                        OverlayForm form = captureUi;
                        if (form != null)
                        {
                            try { form.BeginInvoke(new Action(form.RequestCancel)); }
                            catch { }
                        }
                    }
                }
            }
            return CallNextHookEx(hook, code, wParam, lParam);
        }

        static void ReadStdin(Control control)
        {
            Thread thread = new Thread(new ThreadStart(delegate
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    string copy = line;
                    try
                    {
                        control.BeginInvoke(new Action(delegate { HandleLine(copy); }));
                    }
                    catch
                    {
                        break;
                    }
                }
            }));
            thread.IsBackground = true;
            thread.Start();
        }

        static bool TryParse(string chord, out uint mods, out uint vk, out string error)
        {
            mods = 0;
            vk = 0;
            error = null;
            string[] parts = chord.ToLowerInvariant().Split('+');
            if (parts.Length < 2)
            {
                error = "\u9700\u8981\u4fee\u9970\u952e";
                return false;
            }
            for (int i = 0; i < parts.Length - 1; i++)
            {
                string part = parts[i];
                if (part == "ctrl" || part == "control") mods |= 0x0002;
                else if (part == "alt") mods |= 0x0001;
                else if (part == "shift") mods |= 0x0004;
                else if (part == "win" || part == "meta") mods |= 0x0008;
                else
                {
                    error = "\u672a\u77e5\u4fee\u9970\u952e";
                    return false;
                }
            }
            vk = ToVk(parts[parts.Length - 1]);
            if (vk == 0)
            {
                error = "\u672a\u77e5\u6309\u952e";
                return false;
            }
            return true;
        }

        static uint ToVk(string key)
        {
            if (key.Length == 1)
            {
                char c = key[0];
                if (c >= 'a' && c <= 'z') return (uint)char.ToUpperInvariant(c);
                if (c >= '0' && c <= '9') return (uint)c;
            }
            if (key.Length >= 2 && key[0] == 'f')
            {
                int n;
                if (int.TryParse(key.Substring(1), out n) && n >= 1 && n <= 12) return (uint)(0x70 + n - 1);
            }
            if (key == "space") return 0x20;
            if (key == "enter") return 0x0D;
            if (key == "tab") return 0x09;
            if (key == "escape") return 0x1B;
            if (key == "left") return 0x25;
            if (key == "up") return 0x26;
            if (key == "right") return 0x27;
            if (key == "down") return 0x28;
            return 0;
        }

        static string Field(string json, string name)
        {
            string token = "\"" + name + "\":\"";
            int start = json.IndexOf(token, StringComparison.Ordinal);
            if (start < 0) return null;
            start += token.Length;
            int end = json.IndexOf('"', start);
            if (end < 0) return null;
            return json.Substring(start, end - start);
        }

        static void CaptureLog(string line)
        {
            try
            {
                File.AppendAllText(Path.Combine(Path.GetTempPath(), "ctk-capture.log"),
                    DateTime.Now.ToString("HH:mm:ss.fff") + " " + line + Environment.NewLine);
            }
            catch { }
        }

        static bool EscIsSafe()
        {
            if (unchecked(Environment.TickCount - ignoreEscUntil) < 0) return false;
            if ((GetKeyState(0x12) & 0x8000) != 0) return false;
            return true;
        }

        static void Emit(string json)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }

        static string Quote(string value)
        {
            if (value == null) return "null";
            return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ") + "\"";
        }

        static Cursor sightCursor;

        static Cursor SightCursor()
        {
            if (sightCursor != null) return sightCursor;
            const int size = 32;
            const int hot = 15;
            const int arm = 12;
            const int gap = 3;
            Bitmap color = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(color))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.None;
                g.PixelOffsetMode = PixelOffsetMode.None;
                using (Pen outer = new Pen(Color.White, 3f))
                using (Pen inner = new Pen(Color.Black, 1f))
                {
                    outer.StartCap = LineCap.Square;
                    outer.EndCap = LineCap.Square;
                    inner.StartCap = LineCap.Square;
                    inner.EndCap = LineCap.Square;
                    DrawCross(g, outer, hot, arm, gap);
                    DrawCross(g, inner, hot, arm, gap);
                }
            }
            Bitmap mask = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(mask))
            {
                g.Clear(Color.White);
                for (int y = 0; y < size; y++)
                {
                    for (int x = 0; x < size; x++)
                    {
                        if (color.GetPixel(x, y).A > 0) mask.SetPixel(x, y, Color.Black);
                    }
                }
            }
            IconInfo info = new IconInfo();
            info.fIcon = 0;
            info.xHotspot = hot;
            info.yHotspot = hot;
            info.hbmMask = mask.GetHbitmap();
            info.hbmColor = color.GetHbitmap();
            IntPtr handle = CreateIconIndirect(ref info);
            DeleteObject(info.hbmMask);
            DeleteObject(info.hbmColor);
            color.Dispose();
            mask.Dispose();
            sightCursor = handle == IntPtr.Zero ? Cursors.Cross : new Cursor(handle);
            return sightCursor;
        }

        static void DrawCross(Graphics g, Pen pen, int center, int arm, int gap)
        {
            g.DrawLine(pen, center - arm, center, center - gap, center);
            g.DrawLine(pen, center + gap, center, center + arm, center);
            g.DrawLine(pen, center, center - arm, center, center - gap);
            g.DrawLine(pen, center, center + gap, center, center + arm);
        }

        static void RestoreCursor()
        {
            Cursor.Current = Cursors.Default;
            SetCursor(LoadCursor(IntPtr.Zero, 32512));
        }

        static void EnableDpi()
        {
            try
            {
                if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware();
            }
            catch
            {
                try { SetProcessDPIAware(); } catch { }
            }
        }

        delegate IntPtr LowLevelProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")]
        static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
        [DllImport("user32.dll")]
        static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")]
        static extern short GetKeyState(int vk);
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hwnd, int cmd);
        delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr extra);
        [DllImport("user32.dll")]
        static extern bool EnumWindows(EnumWindowsProc proc, IntPtr extra);
        [DllImport("user32.dll")]
        static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool SetWindowText(IntPtr hwnd, string text);
        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("user32.dll")]
        static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")]
        static extern int GetWindowLong(IntPtr hWnd, int nIndex);
        [DllImport("user32.dll")]
        static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
        [DllImport("user32.dll")]
        static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")]
        static extern bool GetCursorPos(out WinPoint point);

        [StructLayout(LayoutKind.Sequential)]
        struct WinPoint { public int X; public int Y; }
        [DllImport("user32.dll")]
        static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
        [DllImport("user32.dll")]
        static extern IntPtr WindowFromPoint(WinPoint point);
        [DllImport("user32.dll")]
        static extern IntPtr GetParent(IntPtr hwnd);
        [DllImport("user32.dll")]
        static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wparam, IntPtr lparam);
        [DllImport("user32.dll")]
        static extern IntPtr LoadCursor(IntPtr instance, int cursor);
        [DllImport("user32.dll")]
        static extern IntPtr SetCursor(IntPtr cursor);
        [DllImport("user32.dll")]
        static extern IntPtr CreateIconIndirect(ref IconInfo info);

        [StructLayout(LayoutKind.Sequential)]
        struct IconInfo
        {
            public int fIcon;
            public int xHotspot;
            public int yHotspot;
            public IntPtr hbmMask;
            public IntPtr hbmColor;
        }
        [DllImport("user32.dll")]
        static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint colorKey, byte alpha, uint flags);
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr destDc, ref WinPoint dest, ref WinSize size, IntPtr sourceDc, ref WinPoint source, uint colorKey, ref BlendFunction blend, uint flags);
        [DllImport("user32.dll")]
        static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")]
        static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
        [DllImport("gdi32.dll")]
        static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")]
        static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")]
        static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapHeader header, uint usage, out IntPtr bits, IntPtr section, uint offset);

        [StructLayout(LayoutKind.Sequential)]
        struct WinSize { public int cx; public int cy; }
        [StructLayout(LayoutKind.Sequential)]
        struct BlendFunction { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
        [StructLayout(LayoutKind.Sequential)]
        struct BitmapHeader {
            public int biSize; public int biWidth; public int biHeight; public short biPlanes; public short biBitCount;
            public int biCompression; public int biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter;
            public int biClrUsed; public int biClrImportant;
        }
        [DllImport("user32.dll")]
        static extern IntPtr SetWindowsHookEx(int id, LowLevelProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")]
        static extern bool UnhookWindowsHookEx(IntPtr hookId);
        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hookId, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
        static extern IntPtr GetModuleHandle(string name);

        class HotkeyForm : Form
        {
            readonly NotifyIcon tray;

            public HotkeyForm()
            {
                ShowInTaskbar = false;
                FormBorderStyle = FormBorderStyle.None;
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                Size = new Size(1, 1);
                Opacity = 0;

                ContextMenuStrip menu = new ContextMenuStrip();
                menu.Items.Add(Item("\u6253\u5f00\u5de5\u4f5c\u53f0", "open"));
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add(Item("\u622a\u56fe    Alt+9", "scroll"));
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add(Item("\u9000\u51fa\u5de5\u4f5c\u53f0", "exit"));
                tray = new NotifyIcon();
                try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
                catch { tray.Icon = SystemIcons.Application; }
                Icon = tray.Icon;
                tray.Text = "\u5de5\u4f5c\u53f0";
                tray.ContextMenuStrip = menu;
                tray.Visible = true;
                tray.DoubleClick += delegate { Program.Emit("{\"type\":\"tray\",\"action\":\"open\"}"); };
            }

            ToolStripMenuItem Item(string text, string action)
            {
                ToolStripMenuItem item = new ToolStripMenuItem(text);
                item.Click += delegate { Program.Emit("{\"type\":\"tray\",\"action\":" + Program.Quote(action) + "}"); };
                return item;
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == WM_HOTKEY) Program.HandleHotkey(m.WParam.ToInt32());
                base.WndProc(ref m);
            }

            protected override void OnFormClosed(FormClosedEventArgs e)
            {
                tray.Visible = false;
                tray.Dispose();
                base.OnFormClosed(e);
            }
        }

        class HudForm : Form
        {
            string text = "";

            public HudForm(Rectangle anchor)
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                StartPosition = FormStartPosition.Manual;
                BackColor = Color.FromArgb(29, 27, 21);
                ForeColor = Color.FromArgb(242, 241, 237);
                Font = new Font("Microsoft YaHei UI", 9f);
                ClientSize = new Size(250, 36);
                int x = anchor.X + Math.Max(0, (anchor.Width - Width) / 2);
                int y = anchor.Y - Height - 12;
                Rectangle area = SystemInformation.VirtualScreen;
                if (y < area.Top + 8) y = anchor.Bottom + 12;
                Location = new Point(Math.Max(area.Left + 8, x), y);
                ApplyShape();
            }

            void ApplyShape()
            {
                using (GraphicsPath path = Round(new Rectangle(0, 0, Width, Height), 10))
                    Region = new Region(path);
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams value = base.CreateParams;
                    value.ExStyle |= 0x08000000 | 0x00000080 | 0x00000008;
                    return value;
                }
            }

            public void SetText(string text)
            {
                if (IsDisposed) return;
                if (InvokeRequired)
                {
                    BeginInvoke(new Action<string>(SetText), text);
                    return;
                }
                this.text = text;
                Invalidate();
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.Clear(BackColor);
                using (Pen accent = new Pen(Color.FromArgb(129, 161, 193), 3f))
                    e.Graphics.DrawLine(accent, 12, 10, 12, Height - 10);
                TextRenderer.DrawText(e.Graphics, text, Font, new Rectangle(22, 0, Width - 30, Height), ForeColor,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            }
        }

        class OverlayForm : Form
        {
            const int NewSelection = 1;
            const int MoveSelection = 2;
            const int NorthWest = 3;
            const int North = 4;
            const int NorthEast = 5;
            const int East = 6;
            const int SouthEast = 7;
            const int South = 8;
            const int SouthWest = 9;
            const int West = 10;

            readonly SelectionChromeForm chrome;
            readonly CaptureToolbar toolbar;
            byte[] smokePixels;
            bool inVisible;
            Point anchor;
            Point dragStart;
            Rectangle dragRect;
            int dragMode;
            bool dragging;
            public bool Accepted;
            public string Action = "";
            public Rectangle Selected = Rectangle.Empty;

            public OverlayForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                StartPosition = FormStartPosition.Manual;
                Bounds = SystemInformation.VirtualScreen;
                BackColor = Color.Black;
                Cursor = Program.SightCursor();
                KeyPreview = true;
                SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.Opaque, true);

                chrome = new SelectionChromeForm();
                toolbar = new CaptureToolbar(ToolbarAction);
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams value = base.CreateParams;
                    value.ExStyle |= 0x00080000 | 0x00000080 | 0x00000008;
                    return value;
                }
            }

            protected override void SetVisibleCore(bool value)
            {
                if (inVisible)
                {
                    base.SetVisibleCore(value);
                    return;
                }
                inVisible = true;
                try
                {
                    if (value && !IsHandleCreated) CreateHandle();
                    if (value) PresentSmoke();
                    base.SetVisibleCore(value);
                }
                finally
                {
                    inVisible = false;
                }
            }

            protected override void OnShown(EventArgs e)
            {
                base.OnShown(e);
                Cursor = Program.SightCursor();
                Program.ShowWindow(Handle, 5);
                PresentSmoke();
                chrome.Show();
                chrome.SetSelection(Rectangle.Empty, Program.DragHint);
                Restack(false);
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0112 && (m.WParam.ToInt32() & 0xFFF0) == 0xF100)
                {
                    return;
                }
                base.WndProc(ref m);
            }

            protected override bool ProcessDialogKey(Keys keyData)
            {
                if ((keyData & Keys.KeyCode) == Keys.Escape)
                {
                    if (!Program.EscIsSafe()) return true;
                    CancelCapture();
                    return true;
                }
                return base.ProcessDialogKey(keyData);
            }

            protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
            {
                if ((keyData & Keys.KeyCode) == Keys.Escape)
                {
                    if (!Program.EscIsSafe()) return true;
                    CancelCapture();
                    return true;
                }
                if (keyData == Keys.Enter && !Selected.IsEmpty)
                {
                    Confirm("done");
                    return true;
                }
                if (keyData == Keys.S && !Selected.IsEmpty)
                {
                    Confirm("scroll");
                    return true;
                }
                return base.ProcessCmdKey(ref msg, keyData);
            }

            protected override void OnPaintBackground(PaintEventArgs e)
            {
            }

            protected override void OnPaint(PaintEventArgs e)
            {
            }

            void Restack(bool withToolbar)
            {
                IntPtr top = new IntPtr(-1);
                const uint flags = 0x0013;
                if (chrome.IsHandleCreated) Program.SetWindowPos(chrome.Handle, top, 0, 0, 0, 0, flags);
                if (withToolbar && toolbar.Visible && toolbar.IsHandleCreated)
                    Program.SetWindowPos(toolbar.Handle, top, 0, 0, 0, 0, flags);
            }

            void PresentSmoke()
            {
                try
                {
                    PresentSmokeCore();
                }
                catch (Exception ex)
                {
                    Program.CaptureLog("present " + ex.Message);
                }
            }

            void PresentSmokeCore()
            {
                int width = Width;
                int height = Height;
                if (width < 1 || height < 1 || !IsHandleCreated) return;
                Rectangle hole = ClientSelection();
                int stride = width * 4;
                int length = stride * height;
                if (smokePixels == null || smokePixels.Length != length)
                {
                    smokePixels = new byte[length];
                    for (int i = 3; i < smokePixels.Length; i += 4) smokePixels[i] = 128;
                }
                else
                {
                    for (int i = 3; i < smokePixels.Length; i += 4) smokePixels[i] = 128;
                }
                byte[] pixels = smokePixels;
                if (!hole.IsEmpty)
                {
                    int left = Math.Max(0, hole.Left);
                    int top = Math.Max(0, hole.Top);
                    int right = Math.Min(width, hole.Right);
                    int bottom = Math.Min(height, hole.Bottom);
                    for (int y = top; y < bottom; y++)
                    {
                        int row = y * stride + left * 4;
                        for (int x = left; x < right; x++)
                        {
                            pixels[row + 3] = 1;
                            row += 4;
                        }
                    }
                }
                IntPtr screenDc = Program.GetDC(IntPtr.Zero);
                IntPtr memoryDc = Program.CreateCompatibleDC(screenDc);
                Program.BitmapHeader header = new Program.BitmapHeader();
                header.biSize = Marshal.SizeOf(typeof(Program.BitmapHeader));
                header.biWidth = width;
                header.biHeight = -height;
                header.biPlanes = 1;
                header.biBitCount = 32;
                IntPtr bits;
                IntPtr dib = Program.CreateDIBSection(screenDc, ref header, 0, out bits, IntPtr.Zero, 0);
                if (dib == IntPtr.Zero || bits == IntPtr.Zero)
                {
                    Program.DeleteDC(memoryDc);
                    Program.ReleaseDC(IntPtr.Zero, screenDc);
                    return;
                }
                Marshal.Copy(pixels, 0, bits, pixels.Length);
                IntPtr old = Program.SelectObject(memoryDc, dib);
                Program.WinSize size = new Program.WinSize();
                size.cx = width;
                size.cy = height;
                Program.WinPoint origin = new Program.WinPoint();
                Program.WinPoint dest = new Program.WinPoint();
                dest.X = Left;
                dest.Y = Top;
                Program.BlendFunction blend = new Program.BlendFunction();
                blend.BlendOp = 0;
                blend.SourceConstantAlpha = 255;
                blend.AlphaFormat = 1;
                Program.UpdateLayeredWindow(Handle, screenDc, ref dest, ref size, memoryDc, ref origin, 0, ref blend, 2);
                Program.SelectObject(memoryDc, old);
                Program.DeleteObject(dib);
                Program.DeleteDC(memoryDc);
                Program.ReleaseDC(IntPtr.Zero, screenDc);
            }

            protected override void OnMouseDown(MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Right)
                {
                    CancelCapture();
                    return;
                }
                if (e.Button != MouseButtons.Left) return;
                toolbar.Hide();
                dragStart = PointToScreen(e.Location);
                dragRect = Selected;
                dragMode = HitTestSelection(e.Location);
                if (dragMode == 0)
                {
                    dragMode = NewSelection;
                    anchor = dragStart;
                    Selected = Rectangle.Empty;
                }
                dragging = true;
                Capture = true;
                UpdateSelection(dragStart);
            }

            protected override void OnMouseMove(MouseEventArgs e)
            {
                Point screen = PointToScreen(e.Location);
                if (dragging)
                {
                    UpdateSelection(screen);
                    return;
                }
                SetCursor(HitTestSelection(e.Location));
            }

            protected override void OnMouseUp(MouseEventArgs e)
            {
                if (!dragging || e.Button != MouseButtons.Left) return;
                dragging = false;
                Capture = false;
                UpdateSelection(PointToScreen(e.Location));
                if (Selected.Width < 8 || Selected.Height < 8)
                {
                    Selected = Rectangle.Empty;
                    PresentSmoke();
                    chrome.SetSelection(Rectangle.Empty, Program.TooSmall);
                    toolbar.Hide();
                    Invalidate();
                    return;
                }
                ShowChrome();
            }

            protected override void OnMouseDoubleClick(MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left && !Selected.IsEmpty && ClientSelection().Contains(e.Location))
                    Confirm("done");
                else
                    base.OnMouseDoubleClick(e);
            }

            void UpdateSelection(Point screen)
            {
                if (dragMode == NewSelection)
                {
                    Selected = Program.Normalize(anchor, screen);
                }
                else if (dragMode == MoveSelection)
                {
                    int dx = screen.X - dragStart.X;
                    int dy = screen.Y - dragStart.Y;
                    Rectangle moved = new Rectangle(dragRect.X + dx, dragRect.Y + dy, dragRect.Width, dragRect.Height);
                    Rectangle area = SystemInformation.VirtualScreen;
                    if (moved.Left < area.Left) moved.X = area.Left;
                    if (moved.Top < area.Top) moved.Y = area.Top;
                    if (moved.Right > area.Right) moved.X = area.Right - moved.Width;
                    if (moved.Bottom > area.Bottom) moved.Y = area.Bottom - moved.Height;
                    Selected = moved;
                }
                else
                {
                    int left = dragRect.Left;
                    int top = dragRect.Top;
                    int right = dragRect.Right;
                    int bottom = dragRect.Bottom;
                    if (dragMode == NorthWest || dragMode == West || dragMode == SouthWest) left = screen.X;
                    if (dragMode == NorthWest || dragMode == North || dragMode == NorthEast) top = screen.Y;
                    if (dragMode == NorthEast || dragMode == East || dragMode == SouthEast) right = screen.X;
                    if (dragMode == SouthWest || dragMode == South || dragMode == SouthEast) bottom = screen.Y;
                    Selected = Rectangle.FromLTRB(Math.Min(left, right), Math.Min(top, bottom), Math.Max(left, right), Math.Max(top, bottom));
                }
                Selected = Program.ClampToVirtual(Selected);
                PresentSmoke();
                chrome.SetSelection(Selected, Selected.Width + " \u00d7 " + Selected.Height);
                Invalidate();
            }

            int HitTestSelection(Point client)
            {
                Rectangle rect = ClientSelection();
                if (rect.IsEmpty) return 0;
                int gap = 7;
                bool left = Math.Abs(client.X - rect.Left) <= gap;
                bool right = Math.Abs(client.X - rect.Right) <= gap;
                bool top = Math.Abs(client.Y - rect.Top) <= gap;
                bool bottom = Math.Abs(client.Y - rect.Bottom) <= gap;
                if (left && top) return NorthWest;
                if (right && top) return NorthEast;
                if (right && bottom) return SouthEast;
                if (left && bottom) return SouthWest;
                if (top && client.X >= rect.Left && client.X <= rect.Right) return North;
                if (right && client.Y >= rect.Top && client.Y <= rect.Bottom) return East;
                if (bottom && client.X >= rect.Left && client.X <= rect.Right) return South;
                if (left && client.Y >= rect.Top && client.Y <= rect.Bottom) return West;
                return rect.Contains(client) ? MoveSelection : 0;
            }

            void SetCursor(int mode)
            {
                if (mode == MoveSelection) Cursor = Cursors.SizeAll;
                else if (mode == NorthWest || mode == SouthEast) Cursor = Cursors.SizeNWSE;
                else if (mode == NorthEast || mode == SouthWest) Cursor = Cursors.SizeNESW;
                else if (mode == North || mode == South) Cursor = Cursors.SizeNS;
                else if (mode == East || mode == West) Cursor = Cursors.SizeWE;
                else Cursor = Program.SightCursor();
            }

            Rectangle ClientSelection()
            {
                if (Selected.IsEmpty) return Rectangle.Empty;
                return new Rectangle(Selected.X - Left, Selected.Y - Top, Selected.Width, Selected.Height);
            }

            void ShowChrome()
            {
                PresentSmoke();
                chrome.SetSelection(Selected, Selected.Width + " \u00d7 " + Selected.Height);
                int width = toolbar.Width;
                int x = Selected.Right - width;
                int y = Selected.Bottom + 8;
                Rectangle area = SystemInformation.VirtualScreen;
                if (x < area.Left) x = area.Left;
                if (x + width > area.Right) x = area.Right - width;
                if (y + toolbar.Height > area.Bottom) y = Selected.Top - toolbar.Height - 8;
                toolbar.Location = new Point(x, Math.Max(area.Top, y));
                if (!toolbar.Visible) toolbar.Show(this);
                Activate();
                Restack(true);
            }

            void ToolbarAction(string action)
            {
                if (action == "cancel") CancelCapture();
                else Confirm(action);
            }

            void Confirm(string action)
            {
                if (Selected.Width < 8 || Selected.Height < 8) return;
                Action = action;
                Accepted = true;
                DialogResult = DialogResult.OK;
                Close();
            }

            public void RequestCancel()
            {
                if (IsDisposed) return;
                BeginInvoke(new Action(CancelCapture));
            }

            protected override void OnFormClosing(FormClosingEventArgs e)
            {
                Program.CaptureLog("closing " + e.CloseReason + " dialog=" + DialogResult);
                if (DialogResult == DialogResult.None) DialogResult = DialogResult.Cancel;
                base.OnFormClosing(e);
            }

            void CancelCapture()
            {
                if (IsDisposed) return;
                Program.CaptureLog("cancel");
                Accepted = false;
                DialogResult = DialogResult.Cancel;
                Close();
            }

            protected override void OnFormClosed(FormClosedEventArgs e)
            {
                Cursor = Cursors.Default;
                Program.RestoreCursor();
                Capture = false;
                toolbar.Close();
                toolbar.Dispose();
                chrome.Close();
                chrome.Dispose();
                base.OnFormClosed(e);
            }
        }

        class SelectionChromeForm : Form
        {
            static readonly Color Accent = Color.FromArgb(129, 161, 193);
            static readonly Color Ink = Color.FromArgb(29, 27, 21);
            static readonly Color Paper = Color.FromArgb(247, 247, 244);
            readonly Font font = new Font("Microsoft YaHei UI", 9f);
            Rectangle selection = Rectangle.Empty;
            string message = "";

            public SelectionChromeForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                StartPosition = FormStartPosition.Manual;
                Bounds = SystemInformation.VirtualScreen;
                BackColor = Color.FromArgb(29, 27, 21);
                DoubleBuffered = true;
                Region = new Region(new Rectangle(24, 24, 220, 26));
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams value = base.CreateParams;
                    value.ExStyle |= 0x00000020 | 0x08000000 | 0x00000080;
                    return value;
                }
            }

            public void SetSelection(Rectangle screen, string text)
            {
                selection = screen.IsEmpty
                    ? Rectangle.Empty
                    : new Rectangle(screen.X - Left, screen.Y - Top, screen.Width, screen.Height);
                message = text ?? "";
                UpdateChromeRegion();
                Invalidate();
            }

            void UpdateChromeRegion()
            {
                Rectangle badge = BadgeRect();
                Region next = new Region(badge);
                if (!selection.IsEmpty)
                {
                    Rectangle outer = selection;
                    outer.Inflate(8, 8);
                    next.Union(outer);
                    Rectangle hole = selection;
                    hole.Inflate(-8, -8);
                    if (hole.Width > 0 && hole.Height > 0) next.Exclude(hole);
                }
                Region previous = Region;
                Region = next;
                if (previous != null) previous.Dispose();
            }

            Rectangle BadgeRect()
            {
                Size measured = TextRenderer.MeasureText(string.IsNullOrEmpty(message) ? " " : message, font);
                int width = Math.Max(96, measured.Width + 18);
                if (selection.IsEmpty) return new Rectangle(24, 24, width, 26);
                int x = Math.Max(8, Math.Min(Math.Max(8, ClientSize.Width - width - 8), selection.Left));
                int y = selection.Top - 32;
                if (y < 8) y = Math.Min(Math.Max(8, ClientSize.Height - 32), selection.Bottom + 8);
                return new Rectangle(x, y, width, 26);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.None;
                e.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
                Rectangle badge = BadgeRect();
                if (selection.IsEmpty)
                {
                    DrawBadge(e.Graphics, badge, message);
                    return;
                }
                Rectangle box = selection;
                using (Pen white = new Pen(Color.White, 1f))
                using (Pen accent = new Pen(Accent, 2f))
                {
                    e.Graphics.DrawRectangle(white, box.X - 1, box.Y - 1, box.Width + 1, box.Height + 1);
                    e.Graphics.DrawRectangle(accent, box.X + 1, box.Y + 1, Math.Max(1, box.Width - 3), Math.Max(1, box.Height - 3));
                }
                DrawCorner(e.Graphics, box.Left, box.Top, 1, 1);
                DrawCorner(e.Graphics, box.Right - 1, box.Top, -1, 1);
                DrawCorner(e.Graphics, box.Right - 1, box.Bottom - 1, -1, -1);
                DrawCorner(e.Graphics, box.Left, box.Bottom - 1, 1, -1);
                Point[] points = new Point[] {
                    new Point(box.Left, box.Top), new Point(box.Left + box.Width / 2, box.Top), new Point(box.Right - 1, box.Top),
                    new Point(box.Right - 1, box.Top + box.Height / 2), new Point(box.Right - 1, box.Bottom - 1),
                    new Point(box.Left + box.Width / 2, box.Bottom - 1), new Point(box.Left, box.Bottom - 1),
                    new Point(box.Left, box.Top + box.Height / 2)
                };
                for (int i = 0; i < points.Length; i++)
                {
                    Rectangle handle = new Rectangle(points[i].X - 4, points[i].Y - 4, 9, 9);
                    using (Brush fill = new SolidBrush(Paper)) e.Graphics.FillRectangle(fill, handle);
                    using (Pen edge = new Pen(Ink, 1f)) e.Graphics.DrawRectangle(edge, handle);
                }
                DrawBadge(e.Graphics, badge, message);
            }

            void DrawCorner(Graphics graphics, int x, int y, int hx, int hy)
            {
                using (Brush brush = new SolidBrush(Accent))
                {
                    graphics.FillRectangle(brush, Math.Min(x, x + 20 * hx), y - 1, 21, 3);
                    graphics.FillRectangle(brush, x - 1, Math.Min(y, y + 20 * hy), 3, 21);
                }
            }

            void DrawBadge(Graphics graphics, Rectangle box, string text)
            {
                if (string.IsNullOrEmpty(text)) return;
                using (Brush fill = new SolidBrush(Ink)) graphics.FillRectangle(fill, box);
                using (Pen edge = new Pen(Color.FromArgb(68, 64, 56), 1f)) graphics.DrawRectangle(edge, box.X, box.Y, box.Width - 1, box.Height - 1);
                TextRenderer.DrawText(graphics, text, font, box, Paper, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }

            protected override void Dispose(bool disposing)
            {
                if (disposing) font.Dispose();
                base.Dispose(disposing);
            }
        }

        class CaptureToolbar : Form
        {
            class ToolItem
            {
                public string Id;
                public string Glyph;
                public string Text;
                public Rectangle Bounds;
                public bool Primary;
            }

            readonly Action<string> callback;
            readonly Font textFont = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular);
            readonly Font iconFont = new Font("Segoe Fluent Icons", 11f, FontStyle.Regular);
            readonly List<ToolItem> items = new List<ToolItem>();
            string hover = "";

            public CaptureToolbar(Action<string> onAction)
            {
                callback = onAction;
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                TopMost = true;
                StartPosition = FormStartPosition.Manual;
                BackColor = Color.FromArgb(29, 27, 21);
                ForeColor = Color.FromArgb(242, 241, 237);
                DoubleBuffered = true;
                items.Add(Make("copy", "\uE8C8", "\u590d\u5236", false));
                items.Add(Make("save", "\uE74E", "\u4fdd\u5b58", false));
                items.Add(Make("scroll", "\uE8CB", "\u6eda\u52a8", false));
                items.Add(Make("cancel", "\uE711", "\u53d6\u6d88", false));
                items.Add(Make("done", "\uE73E", "\u5b8c\u6210", true));
                int x = 8;
                for (int i = 0; i < items.Count; i++)
                {
                    if (i == 3) x += 13;
                    Size measured = TextRenderer.MeasureText(items[i].Text, textFont);
                    int width = 34 + measured.Width;
                    items[i].Bounds = new Rectangle(x, 6, width, 32);
                    x += width + 4;
                }
                ClientSize = new Size(x + 4, 44);
                using (GraphicsPath path = Program.Round(new Rectangle(0, 0, Width, Height), 10))
                    Region = new Region(path);
            }

            static ToolItem Make(string id, string glyph, string text, bool primary)
            {
                ToolItem item = new ToolItem();
                item.Id = id;
                item.Glyph = glyph;
                item.Text = text;
                item.Primary = primary;
                return item;
            }

            protected override bool ShowWithoutActivation
            {
                get { return true; }
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams value = base.CreateParams;
                    value.ExStyle |= 0x00000080 | 0x08000000 | 0x00000008;
                    return value;
                }
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.Clear(Color.FromArgb(29, 27, 21));
                using (Pen border = new Pen(Color.FromArgb(72, 68, 58)))
                using (GraphicsPath path = Program.Round(new Rectangle(0, 0, Width - 1, Height - 1), 10))
                    e.Graphics.DrawPath(border, path);
                using (Pen divider = new Pen(Color.FromArgb(72, 68, 58)))
                    e.Graphics.DrawLine(divider, items[3].Bounds.Left - 8, 12, items[3].Bounds.Left - 8, Height - 12);
                for (int i = 0; i < items.Count; i++) DrawItem(e.Graphics, items[i]);
            }

            void DrawItem(Graphics graphics, ToolItem item)
            {
                bool hot = hover == item.Id;
                Color fill = item.Primary ? Color.FromArgb(129, 161, 193) : hot ? Color.FromArgb(54, 51, 44) : Color.FromArgb(38, 37, 32);
                Color ink = item.Primary ? Color.FromArgb(25, 28, 34) : Color.FromArgb(242, 241, 237);
                using (GraphicsPath path = Program.Round(item.Bounds, 8))
                using (Brush brush = new SolidBrush(fill))
                    graphics.FillPath(brush, path);
                TextRenderer.DrawText(graphics, item.Glyph, iconFont, new Rectangle(item.Bounds.X + 7, item.Bounds.Y, 18, item.Bounds.Height), ink,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
                TextRenderer.DrawText(graphics, item.Text, textFont, new Rectangle(item.Bounds.X + 26, item.Bounds.Y, item.Bounds.Width - 30, item.Bounds.Height), ink,
                    TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
            }

            protected override void OnMouseMove(MouseEventArgs e)
            {
                string next = "";
                ToolItem item = Hit(e.Location);
                if (item != null) next = item.Id;
                if (next == hover) return;
                hover = next;
                Cursor = next.Length == 0 ? Cursors.Default : Cursors.Hand;
                Invalidate();
            }

            protected override void OnMouseLeave(EventArgs e)
            {
                hover = "";
                Cursor = Cursors.Default;
                Invalidate();
            }

            protected override void OnMouseDown(MouseEventArgs e)
            {
                if (e.Button != MouseButtons.Left) return;
                ToolItem item = Hit(e.Location);
                if (item != null) callback(item.Id);
            }

            ToolItem Hit(Point point)
            {
                for (int i = 0; i < items.Count; i++)
                    if (items[i].Bounds.Contains(point)) return items[i];
                return null;
            }

            protected override void Dispose(bool disposing)
            {
                if (disposing)
                {
                    textFont.Dispose();
                    iconFont.Dispose();
                }
                base.Dispose(disposing);
            }
        }
    }
}
