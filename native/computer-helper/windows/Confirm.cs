// The broker's own confirmation windows: at its start, naming the program it is to drive and who
// asks, and before each risky step, with a crop of the window around it. They belong to a process
// running as administrator, so Windows lets no normal process click them, and the driver the broker
// runs acts only on the approved program's windows. No answer within two minutes is a no.
//
// A test build shows none: it answers from KITE_BROKER_TEST_ANSWER (allow or deny, or a list of them
// in turn) and writes each
// question to the file KITE_BROKER_TEST_LOG names, one JSON object per line.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Kite.ComputerHelper
{
    static class Confirm
    {
        const int WaitMs = 120000;

        public static bool Chinese;
        static int testAsked;

        static string T(string zh, string en)
        {
            return Chinese ? zh : en;
        }

        /// <summary>The start: may Kite drive this program as administrator?</summary>
        public static bool Start(string targetImage, int targetPid, string windowTitle, string client)
        {
            string body = T(
                "纸鸢请求以管理员权限操作这个程序：\r\n\r\n" + targetImage + "\r\n进程 " + targetPid +
                (string.IsNullOrEmpty(windowTitle) ? "" : "，窗口「" + windowTitle + "」") +
                "\r\n\r\n请求方：" + client +
                "\r\n\r\n允许后，纸鸢只操作这个程序的窗口，只在后台操作，有风险的步骤会在这样的窗口里再问你；这期间这个程序不能启动别的程序。" +
                "\r\n\r\n纸鸢的管理员助手没有代码签名证书，刚才 Windows 显示的是「未知发布者」。只有你刚刚在纸鸢里允许过，才点“允许”。",
                "Kite asks to operate this program as administrator:\r\n\r\n" + targetImage + "\r\nProcess " + targetPid +
                (string.IsNullOrEmpty(windowTitle) ? "" : ", window “" + windowTitle + "”") +
                "\r\n\r\nAsked by: " + client +
                "\r\n\r\nIf you allow it, Kite acts only on this program's windows, in the background, and asks you again in a window like this before risky steps; meanwhile the program cannot start other programs." +
                "\r\n\r\nKite's administrator helper has no code-signing certificate, so Windows just showed an unknown publisher. Allow only if you just allowed this in Kite.");
            var question = new Dictionary<string, object> { { "kind", "start" }, { "target", targetImage }, { "pid", targetPid }, { "client", client } };
            return Ask(T("纸鸢 · 管理员权限", "Kite · Administrator"), body, null, question, T("允许", "Allow"), T("拒绝", "Deny"));
        }

        /// <summary>A risky step: may Kite take it?</summary>
        public static bool Step(string targetImage, Step step, Bitmap crop)
        {
            string what = Describe(step);
            string body = T(
                "纸鸢想以管理员权限在这个程序里执行一步：\r\n" + Path.GetFileName(targetImage) + "\r\n\r\n" + what,
                "Kite wants to take a step as administrator in this program:\r\n" + Path.GetFileName(targetImage) + "\r\n\r\n" + what);
            var question = new Dictionary<string, object>
            {
                { "kind", "step" }, { "step", step.Kind }, { "text", step.Text }, { "role", step.Role }, { "crop", crop != null },
            };
            return Ask(T("纸鸢 · 确认这一步", "Kite · Confirm this step"), body, crop, question, T("执行", "Do it"), T("不执行", "Don't"));
        }

        static string Describe(Step step)
        {
            string text = step.Text == null ? null : Shorten(step.Text);
            string role = string.IsNullOrEmpty(step.Role) ? "" : " (" + step.Role + ")";
            switch (step.Kind)
            {
                case "click":
                    return text == null ? T("点击图中红框处", "Click where the red box is") : T("点击「" + text + "」" + role, "Click “" + text + "”" + role);
                case "right-click":
                    return text == null ? T("右键点击图中红框处", "Right-click where the red box is") : T("右键点击「" + text + "」" + role, "Right-click “" + text + "”" + role);
                case "double-click":
                    return text == null ? T("双击图中红框处", "Double-click where the red box is") : T("双击「" + text + "」" + role, "Double-click “" + text + "”" + role);
                case "type":
                    return T("输入下面的文字（⏎ 是换行，会提交）：\r\n", "Type this text (⏎ is a line break, which submits):\r\n") + text;
                case "key":
                    return T("按键 " + text, "Press " + text);
                case "drag":
                    return T("从图中红框处拖动", "Drag from where the red box is");
                case "menu":
                    return T("选择菜单 " + text, "Choose the menu item " + text);
                default:
                    return step.Kind;
            }
        }

        static string Shorten(string text)
        {
            string shown = text.Replace("\r\n", "⏎").Replace('\n', '⏎').Replace('\r', '⏎');
            return shown.Length > 400 ? shown.Substring(0, 400) + "…" : shown;
        }

        static bool Ask(string title, string body, Bitmap image, Dictionary<string, object> question, string yes, string no)
        {
            if (Build.Test) return TestAnswer(question);
            bool answer = false;
            var thread = new Thread(() => answer = Show(title, body, image, yes, no));
            thread.SetApartmentState(ApartmentState.STA);
            thread.IsBackground = true;
            thread.Start();
            thread.Join();
            return answer;
        }

        static bool TestAnswer(Dictionary<string, object> question)
        {
            string log = Environment.GetEnvironmentVariable("KITE_BROKER_TEST_LOG");
            if (!string.IsNullOrEmpty(log))
            {
                lock (typeof(Confirm)) File.AppendAllText(log, new JavaScriptSerializer().Serialize(question) + "\n", new UTF8Encoding(false));
            }
            // A list such as allow,deny answers in turn, its last answer for every later question.
            string[] answers = (Environment.GetEnvironmentVariable("KITE_BROKER_TEST_ANSWER") ?? "deny").Split(',');
            string answer = answers[Math.Min(testAsked, answers.Length - 1)];
            testAsked++;
            return answer == "allow";
        }

        static bool Show(string title, string body, Bitmap image, string yes, string no)
        {
            Application.EnableVisualStyles();
            using (var form = new Form())
            {
                form.Text = title;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MaximizeBox = false;
                form.MinimizeBox = false;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.TopMost = true;
                form.ShowInTaskbar = true;
                form.Font = new Font("Microsoft YaHei UI", 10f);
                form.AutoSize = true;
                form.AutoSizeMode = AutoSizeMode.GrowAndShrink;
                form.Padding = new Padding(16);
                var layout = new FlowLayoutPanel
                {
                    FlowDirection = FlowDirection.TopDown,
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    WrapContents = false,
                };
                layout.Controls.Add(new Label { Text = body, AutoSize = true, MaximumSize = new Size(560, 0) });
                if (image != null)
                {
                    layout.Controls.Add(new PictureBox
                    {
                        Image = image,
                        SizeMode = PictureBoxSizeMode.Zoom,
                        Size = new Size(Math.Min(560, image.Width), Math.Min(320, image.Height)),
                        BorderStyle = BorderStyle.FixedSingle,
                        Margin = new Padding(0, 12, 0, 0),
                    });
                }
                var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Margin = new Padding(0, 16, 0, 0), Width = 560 };
                var deny = new Button { Text = no, DialogResult = DialogResult.No, AutoSize = true, Padding = new Padding(8, 2, 8, 2) };
                var allow = new Button { Text = yes, DialogResult = DialogResult.Yes, AutoSize = true, Padding = new Padding(8, 2, 8, 2) };
                buttons.Controls.Add(deny);
                buttons.Controls.Add(allow);
                layout.Controls.Add(buttons);
                form.Controls.Add(layout);
                // No is the default, for Enter and Escape alike.
                form.AcceptButton = deny;
                form.CancelButton = deny;
                var timer = new System.Windows.Forms.Timer { Interval = WaitMs };
                timer.Tick += (s, e) => { timer.Stop(); form.DialogResult = DialogResult.No; form.Close(); };
                form.Shown += (s, e) => { form.Activate(); deny.Focus(); timer.Start(); };
                DialogResult result = form.ShowDialog();
                timer.Dispose();
                return result == DialogResult.Yes;
            }
        }

        /// <summary>
        /// The window around a step's place, captured from the window itself, with a red box at the
        /// place; null when the step has no place or the window gives no picture.
        /// </summary>
        public static Bitmap Crop(long windowId, Step step)
        {
            if (!step.HasPlace || windowId <= 0) return null;
            var handle = new IntPtr(windowId);
            Native.RECT rect;
            if (!Native.GetWindowRect(handle, out rect)) return null;
            int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
            if (width <= 0 || height <= 0 || width > 16384 || height > 16384) return null;
            using (var whole = new Bitmap(width, height))
            {
                using (Graphics g = Graphics.FromImage(whole))
                {
                    IntPtr dc = g.GetHdc();
                    bool ok;
                    try { ok = Native.PrintWindow(handle, dc, 2); }
                    finally { g.ReleaseHdc(dc); }
                    if (!ok) return null;
                }
                var box = new Rectangle((int)(step.X - rect.Left), (int)(step.Y - rect.Top), Math.Max(8, (int)step.Width), Math.Max(8, (int)step.Height));
                var area = Rectangle.Inflate(box, 140, 90);
                area.Intersect(new Rectangle(0, 0, width, height));
                if (area.Width <= 0 || area.Height <= 0) return null;
                var crop = whole.Clone(area, whole.PixelFormat);
                using (Graphics g = Graphics.FromImage(crop))
                using (var pen = new Pen(Color.Red, 3))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.DrawRectangle(pen, box.X - area.X - 3, box.Y - area.Y - 3, box.Width + 6, box.Height + 6);
                }
                return crop;
            }
        }
    }
}
