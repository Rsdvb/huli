// The broker's own confirmation windows: at its start, naming the program it is to drive and the
// process that asks, and before each risky step, with a picture of the whole window, a red box at the
// step's place and the list of what went through unconfirmed since the last question. No answer
// within two minutes is a no.
//
// The windows belong to a process running as administrator, which normal processes cannot click
// through Windows' UIPI, though a process that borrows a UIAccess token can. So the button that
// says yes comes alive only once the window has been in front for a second, goes dead again when it
// loses the front, and stays dead while another program's window overlaps it from above, which is
// how a window laid over this one would change what it shows. All text from the program or the agent
// is shown with control, direction and invisible characters made visible.
//
// A test build shows none: it answers from KITE_BROKER_TEST_ANSWER (allow or deny, or a list of them
// in turn) and writes each question to the file KITE_BROKER_TEST_LOG names, one JSON object per line.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Kite.ComputerHelper
{
    /// <summary>The process that asked for the broker, as the start window names it.</summary>
    sealed class Asker
    {
        public string Image;
        public int Pid;
        public string CommandLine;
        public string ParentImage;
    }

    static class Confirm
    {
        const int WaitMs = 120000;
        const int ArmMs = 1000;
        const int PictureWidth = 560;
        const int PictureHeight = 320;

        public static bool Chinese;
        static int testAsked;

        static string T(string zh, string en)
        {
            return Chinese ? zh : en;
        }

        /// <summary>The same in the window's language, for what Risk.cs lists.</summary>
        public static string Say(string zh, string en)
        {
            return T(zh, en);
        }

        /// <summary>
        /// Text as the owner should see it: line breaks as ⏎ (and a break), tabs as ⇥, and every
        /// other control, direction or invisible character as its code point, so none can hide or
        /// reorder what is shown.
        /// </summary>
        public static string Visible(string text)
        {
            if (text == null) return "";
            var shown = new StringBuilder(text.Length + 16);
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') { shown.Append("⏎\r\n"); i++; continue; }
                if (c == '\r' || c == '\n') { shown.Append("⏎\r\n"); continue; }
                if (c == '\t') { shown.Append('⇥'); continue; }
                if (char.IsSurrogate(c))
                {
                    if (char.IsHighSurrogate(c) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
                    {
                        string pair = text.Substring(i, 2);
                        UnicodeCategory category = CharUnicodeInfo.GetUnicodeCategory(pair, 0);
                        if (category == UnicodeCategory.Format || category == UnicodeCategory.PrivateUse) shown.Append(Code(char.ConvertToUtf32(pair, 0)));
                        else shown.Append(pair);
                        i++;
                    }
                    else
                    {
                        shown.Append(Code(c));
                    }
                    continue;
                }
                UnicodeCategory kind = char.GetUnicodeCategory(c);
                if (kind == UnicodeCategory.Control || kind == UnicodeCategory.Format || kind == UnicodeCategory.LineSeparator ||
                    kind == UnicodeCategory.ParagraphSeparator || kind == UnicodeCategory.PrivateUse || c == '­' || c == '͏' ||
                    c == 'ᅟ' || c == 'ᅠ' || c == 'ㅤ' || c == 'ﾠ')
                {
                    shown.Append(Code(c));
                    continue;
                }
                shown.Append(c);
            }
            return shown.ToString();
        }

        static string Code(int codePoint)
        {
            return "⟦U+" + codePoint.ToString("X4", CultureInfo.InvariantCulture) + "⟧";
        }

        /// <summary>A name on one line, made visible and held to 200 characters.</summary>
        public static string Line(string text)
        {
            string shown = Visible(text).Replace("\r\n", " ");
            return shown.Length > 200 ? shown.Substring(0, 200) + "…" : shown;
        }

        /// <summary>The start: may the asking process drive this program as administrator?</summary>
        public static bool Start(string targetImage, int targetPid, string windowTitle, Asker asker)
        {
            string title = string.IsNullOrEmpty(windowTitle) ? null : Line(windowTitle);
            string command = asker.CommandLine == null ? null : Line(asker.CommandLine.Length > 400 ? asker.CommandLine.Substring(0, 400) : asker.CommandLine);
            string body = T(
                "有程序请求以管理员权限操作这个程序：\r\n" + Line(targetImage) + "\r\n进程 " + targetPid +
                (title == null ? "" : "，窗口「" + title + "」") +
                "\r\n\r\n请求方：" + Line(asker.Image) + "（进程 " + asker.Pid + "）" +
                (asker.ParentImage == null ? "" : "\r\n由它启动：" + Line(asker.ParentImage)) +
                (command == null ? "" : "\r\n命令行：" + command) +
                "\r\n\r\n它自称纸鸢。只有你刚刚在纸鸢里允许过，才点“允许”。允许后它只在后台操作这个程序的窗口，有风险的步骤会在这样的窗口里再问你；这期间 Windows 不让这个程序直接启动别的程序，但它请 Windows 服务代办的仍可能启动。",
                "A program asks to operate this program as administrator:\r\n" + Line(targetImage) + "\r\nProcess " + targetPid +
                (title == null ? "" : ", window “" + title + "”") +
                "\r\n\r\nAsked by: " + Line(asker.Image) + " (process " + asker.Pid + ")" +
                (asker.ParentImage == null ? "" : "\r\nStarted by: " + Line(asker.ParentImage)) +
                (command == null ? "" : "\r\nCommand line: " + command) +
                "\r\n\r\nIt says it is Kite. Allow only if you just allowed this in Kite. It then acts only on this program's windows, in the background, and asks you again in a window like this before risky steps. Meanwhile Windows keeps the program from starting other programs directly, though a Windows service it asks may still start one.");
            var question = new Dictionary<string, object>
            {
                { "kind", "start" }, { "target", targetImage }, { "pid", targetPid }, { "title", title },
                { "asker", asker.Image }, { "askerPid", asker.Pid }, { "parent", asker.ParentImage },
            };
            return Ask(T("纸鸢 · 管理员权限", "Kite · Administrator"), body, null, null, question, T("允许", "Allow"), T("拒绝", "Deny"));
        }

        /// <summary>A risky step: may it be taken? `since` lists what went through unconfirmed before it.</summary>
        public static bool Step(string targetImage, Step step, Bitmap picture, IList<string> since)
        {
            string what = Describe(step);
            string body = T(
                "纸鸢想以管理员权限在这个程序里执行一步：" + Line(Path.GetFileName(targetImage)),
                "Kite wants to take a step as administrator in this program: " + Line(Path.GetFileName(targetImage)));
            var details = new StringBuilder(what);
            if (since.Count > 0)
            {
                details.Append("\r\n\r\n").Append(T("上次问你之后，没问就做了这些：", "Since it last asked you, it did these without asking:"));
                int shown = 0;
                foreach (string line in since)
                {
                    if (shown++ == 30)
                    {
                        details.Append("\r\n").Append(T("……还有 " + (since.Count - 30) + " 步", "…and " + (since.Count - 30) + " more"));
                        break;
                    }
                    details.Append("\r\n• ").Append(line);
                }
            }
            if (picture == null) details.Append("\r\n\r\n").Append(T("（没能截到这个窗口的图。）", "(No picture of the window could be taken.)"));
            var question = new Dictionary<string, object>
            {
                { "kind", "step" }, { "step", step.Kind }, { "text", step.Text }, { "role", step.Role },
                { "picture", picture != null }, { "places", step.Places.Count }, { "since", new List<string>(since) },
                { "details", details.ToString() },
            };
            return Ask(T("纸鸢 · 确认这一步", "Kite · Confirm this step"), body, details.ToString(), picture, question, T("执行", "Do it"), T("不执行", "Don't"));
        }

        static string Describe(Step step)
        {
            string role = string.IsNullOrEmpty(step.Role) ? "" : " (" + Line(step.Role) + ")";
            bool named = !string.IsNullOrWhiteSpace(step.Text);
            string text = named ? Line(step.Text) : null;
            switch (step.Kind)
            {
                case "click":
                    return named ? T("点击「" + text + "」" + role + "，图中红框处", "Click “" + text + "”" + role + ", where the red box is") : T("点击图中红框处", "Click where the red box is");
                case "right-click":
                    return named ? T("右键点击「" + text + "」" + role + "，图中红框处", "Right-click “" + text + "”" + role + ", where the red box is") : T("右键点击图中红框处", "Right-click where the red box is");
                case "middle-click":
                    return named ? T("中键点击「" + text + "」" + role + "，图中红框处", "Middle-click “" + text + "”" + role + ", where the red box is") : T("中键点击图中红框处", "Middle-click where the red box is");
                case "double-click":
                    return named ? T("双击「" + text + "」" + role + "，图中红框处", "Double-click “" + text + "”" + role + ", where the red box is") : T("双击图中红框处", "Double-click where the red box is");
                case "type":
                    return T("输入下面的全部文字（" + step.Text.Length + " 个字符；⏎ 是换行，会提交；⇥ 是 Tab，会跳到下一项）：\r\n\r\n",
                        "Type all of this text (" + step.Text.Length + " characters; ⏎ is a line break, which submits; ⇥ is a tab, which moves on):\r\n\r\n") + Visible(step.Text);
                case "key":
                    return T("按键 " + Line(step.Text), "Press " + Line(step.Text));
                case "drag":
                    return T("从图中第一个红框拖到第二个红框", "Drag from the first red box to the second one");
                case "menu":
                    return T("选择菜单 " + Line(step.Text), "Choose the menu item " + Line(step.Text));
                default:
                    return Line(step.Kind);
            }
        }

        static bool Ask(string title, string body, string details, Bitmap image, Dictionary<string, object> question, string yes, string no)
        {
            if (Build.Test) return TestAnswer(question);
            bool answer = false;
            var thread = new Thread(() => answer = Show(title, body, details, image, yes, no));
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

        static bool Show(string title, string body, string details, Bitmap image, string yes, string no)
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
                layout.Controls.Add(new Label { Text = body, AutoSize = true, MaximumSize = new Size(PictureWidth, 0), UseMnemonic = false });
                if (details != null)
                {
                    // A box that scrolls, so every character of a long text can be read, and wraps
                    // a run without spaces too.
                    var box = new TextBox
                    {
                        Text = details,
                        ReadOnly = true,
                        Multiline = true,
                        WordWrap = true,
                        ScrollBars = ScrollBars.Vertical,
                        Width = PictureWidth,
                        Height = Math.Min(220, 24 + 20 * Math.Max(2, details.Split('\n').Length)),
                        Margin = new Padding(0, 8, 0, 0),
                        TabStop = false,
                    };
                    layout.Controls.Add(box);
                }
                if (image != null)
                {
                    layout.Controls.Add(new PictureBox
                    {
                        Image = image,
                        SizeMode = PictureBoxSizeMode.Zoom,
                        Size = new Size(Math.Min(PictureWidth, image.Width), Math.Min(PictureHeight, image.Height)),
                        BorderStyle = BorderStyle.FixedSingle,
                        Margin = new Padding(0, 12, 0, 0),
                    });
                }
                var note = new Label { AutoSize = true, MaximumSize = new Size(PictureWidth, 0), ForeColor = SystemColors.GrayText, Margin = new Padding(0, 12, 0, 0), UseMnemonic = false };
                layout.Controls.Add(note);
                var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, AutoSize = true, Margin = new Padding(0, 8, 0, 0), Width = PictureWidth };
                var deny = new Button { Text = no, DialogResult = DialogResult.No, AutoSize = true, Padding = new Padding(8, 2, 8, 2) };
                var allow = new Button { Text = yes, DialogResult = DialogResult.Yes, AutoSize = true, Padding = new Padding(8, 2, 8, 2), Enabled = false };
                buttons.Controls.Add(deny);
                buttons.Controls.Add(allow);
                layout.Controls.Add(buttons);
                form.Controls.Add(layout);
                // No is the default, for Enter and Escape alike.
                form.AcceptButton = deny;
                form.CancelButton = deny;
                var timeout = new System.Windows.Forms.Timer { Interval = WaitMs };
                timeout.Tick += (s, e) => { timeout.Stop(); form.DialogResult = DialogResult.No; form.Close(); };
                // While the window is open only: whether it may be answered yes yet.
                var arm = new System.Windows.Forms.Timer { Interval = 150 };
                var front = Stopwatch.StartNew();
                bool inFront = false;
                arm.Tick += (s, e) =>
                {
                    bool now = Native.GetForegroundWindow() == form.Handle;
                    if (now && !inFront) front.Restart();
                    inFront = now;
                    int cover = now ? Native.CoveringProcess(form.Handle) : 0;
                    bool ready = now && cover == 0 && front.ElapsedMilliseconds >= ArmMs;
                    if (allow.Enabled != ready) allow.Enabled = ready;
                    string text = !now ? T("点一下这个窗口，一秒后才能选“" + yes + "”。", "Click this window; “" + yes + "” works a second after it is in front.")
                        : cover != 0 ? T("另一个程序的窗口（" + Covering(cover) + "）挡在这个窗口上面，挪开它才能选“" + yes + "”。", "A window of another program (" + Covering(cover) + ") lies over this one; move it away to choose “" + yes + "”.")
                        : "";
                    if (note.Text != text) note.Text = text;
                };
                form.Shown += (s, e) => { form.Activate(); deny.Focus(); timeout.Start(); arm.Start(); };
                DialogResult result = form.ShowDialog();
                arm.Dispose();
                timeout.Dispose();
                return result == DialogResult.Yes;
            }
        }

        static string Covering(int pid)
        {
            string image = pid > 0 ? Native.ImageOf(pid) : null;
            return image == null ? T("未知", "unknown") : Line(Path.GetFileName(image));
        }

        /// <summary>
        /// The whole window, captured from the window itself, with a red box at each of the step's
        /// places and scaled to fit the confirmation; null when the window gives no picture.
        /// </summary>
        public static Bitmap Picture(long windowId, Step step)
        {
            if (windowId <= 0) return null;
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
                double scale = Math.Min(1.0, Math.Min((double)PictureWidth / width, (double)PictureHeight / height));
                int w = Math.Max(1, (int)(width * scale)), h = Math.Max(1, (int)(height * scale));
                var picture = new Bitmap(w, h);
                using (Graphics g = Graphics.FromImage(picture))
                using (var pen = new Pen(Color.Red, 3))
                {
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(whole, 0, 0, w, h);
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    int n = 0;
                    foreach (Place place in step.Places)
                    {
                        float x = (float)((place.X - rect.Left) * scale), y = (float)((place.Y - rect.Top) * scale);
                        float bw = Math.Max(10f, (float)(place.Width * scale)), bh = Math.Max(10f, (float)(place.Height * scale));
                        g.DrawRectangle(pen, x - 3, y - 3, bw + 6, bh + 6);
                        if (step.Places.Count > 1)
                        {
                            using (var font = new Font("Segoe UI", 9f, FontStyle.Bold))
                                g.DrawString((++n).ToString(CultureInfo.InvariantCulture), font, Brushes.Red, x + bw + 6, y - 6);
                        }
                    }
                }
                return picture;
            }
        }
    }
}
