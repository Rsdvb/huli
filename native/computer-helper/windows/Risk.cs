// Which steps in an app run as administrator the owner confirms in the broker's own window: every
// acting step but those plainly harmless. A click is harmless only on an element the snapshot that
// gave its token names, of a role that only focuses or selects, with one plain left click and a
// label that commits nothing; every other click, a bare point included, is confirmed with a crop of
// the window around it. Keys but moving about, shortcuts, typed line breaks, drags and menus are
// confirmed; reading and scrolling are not.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Kite.ComputerHelper
{
    /// <summary>An element as a read of the window gave it, in screen pixels.</summary>
    sealed class Element
    {
        public string Role;
        public string Label;
        public double X, Y, Width, Height;
        public bool HasFrame;
    }

    /// <summary>What one read of a window said: its place, its screenshot's size and its elements.</summary>
    sealed class Snapshot
    {
        public string Id;
        public long WindowId;
        public double WindowX, WindowY, WindowWidth, WindowHeight;
        public double ShotWidth, ShotHeight;
        public readonly Dictionary<long, Element> Elements = new Dictionary<long, Element>();
    }

    /// <summary>A step the owner confirms: what it does, in words, and where in the window.</summary>
    sealed class Step
    {
        public string Kind;
        public string Text;
        public string Role;
        public long WindowId;
        /// <summary>The screen rectangle the step aims at, when it has one.</summary>
        public double X, Y, Width, Height;
        public bool HasPlace;
    }

    static class Risk
    {
        static readonly HashSet<string> BenignRoles = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Edit", "Document", "TabItem", "Tab", "TreeItem", "ListItem", "DataItem", "ScrollBar",
            "Text", "Header", "HeaderItem", "StatusBar", "ToolTip",
        };

        static readonly HashSet<string> MovingKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "tab", "escape", "esc", "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
            "arrowup", "arrowdown", "arrowleft", "arrowright",
        };

        static readonly Regex CommitWords = new Regex(
            @"\b(ok|yes|apply|delete|remove|uninstall|install|format|erase|wipe|reset|run|execute|start|launch|open|submit|confirm|save|overwrite|replace|allow|accept|agree|continue|next|finish|end task|kill|shut down|restart|update|upgrade|change|disable|enable|grant|add|create|new|import|send|copy|move|rename|set)\b",
            RegexOptions.IgnoreCase);

        static readonly string[] CommitWide =
        {
            "确定", "确认", "应用", "删除", "移除", "卸载", "安装", "格式化", "清除", "清空", "重置", "运行", "执行",
            "开始", "启动", "打开", "提交", "保存", "覆盖", "替换", "允许", "接受", "同意", "继续", "下一步", "完成",
            "结束", "关机", "重启", "更新", "升级", "更改", "禁用", "启用", "授权", "添加", "新建", "导入", "发送",
            "复制", "移动", "重命名", "设置", "是", "好",
        };

        public static bool Commits(string label)
        {
            if (string.IsNullOrWhiteSpace(label)) return false;
            string text = Regex.Replace(label, @"\(&\w\)|&", "").Trim();
            return CommitWords.IsMatch(text) || CommitWide.Any(w => text.Contains(w));
        }

        /// <summary>
        /// The confirmation a tool call needs, or null when it is harmless. `snapshot` finds the
        /// snapshot an element token names; `latest` the latest read of a window.
        /// </summary>
        public static Step Assess(string tool, Dictionary<string, object> args, Func<string, Snapshot> snapshot, Func<long, Snapshot> latest)
        {
            long windowId = WindowOf(args);
            switch (tool)
            {
                case "list_windows":
                case "get_window_state":
                case "scroll":
                    return null;
                case "click":
                    return Click(args, windowId, snapshot, latest);
                case "type_text":
                {
                    string text = args.ContainsKey("text") ? args["text"] as string ?? "" : "";
                    if (text.IndexOf('\n') < 0 && text.IndexOf('\r') < 0) return null;
                    return new Step { Kind = "type", Text = text, WindowId = windowId };
                }
                case "press_key":
                {
                    string key = args.ContainsKey("key") ? args["key"] as string ?? "" : "";
                    var modifiers = args.ContainsKey("modifiers") ? args["modifiers"] as System.Collections.IList : null;
                    bool plain = modifiers == null || modifiers.Count == 0;
                    if (plain && MovingKeys.Contains(key.Trim())) return null;
                    var keys = new List<string>();
                    if (modifiers != null) foreach (object m in modifiers) keys.Add(Convert.ToString(m));
                    keys.Add(key);
                    return new Step { Kind = "key", Text = string.Join("+", keys), WindowId = windowId };
                }
                case "hotkey":
                {
                    var keys = args.ContainsKey("keys") ? args["keys"] as System.Collections.IList : null;
                    var names = new List<string>();
                    if (keys != null) foreach (object k in keys) names.Add(Convert.ToString(k));
                    return new Step { Kind = "key", Text = string.Join("+", names), WindowId = windowId };
                }
                case "drag":
                {
                    var step = new Step { Kind = "drag", Text = null, WindowId = windowId };
                    Place(step, latest(windowId), Number(args, "from_x"), Number(args, "from_y"));
                    return step;
                }
                case "invoke_menu":
                {
                    var path = args.ContainsKey("path") ? args["path"] as System.Collections.IList : null;
                    var names = new List<string>();
                    if (path != null) foreach (object p in path) names.Add(Convert.ToString(p));
                    return new Step { Kind = "menu", Text = string.Join(" > ", names), WindowId = windowId };
                }
                default:
                    return new Step { Kind = tool, WindowId = windowId };
            }
        }

        static Step Click(Dictionary<string, object> args, long windowId, Func<string, Snapshot> snapshot, Func<long, Snapshot> latest)
        {
            string button = args.ContainsKey("button") ? args["button"] as string : null;
            long count = args.ContainsKey("count") ? Convert.ToInt64(args["count"]) : 1;
            bool plain = (button == null || button == "left") && count <= 1;
            string kind = button == "right" ? "right-click" : count >= 2 ? "double-click" : "click";
            string token = args.ContainsKey("element_token") ? args["element_token"] as string : null;
            if (token != null)
            {
                int colon = token.IndexOf(':');
                Snapshot read = colon > 0 ? snapshot(token.Substring(0, colon)) : null;
                long row;
                Element element = null;
                if (read != null && long.TryParse(token.Substring(colon + 1), out row)) read.Elements.TryGetValue(row, out element);
                if (element != null && plain && BenignRoles.Contains(element.Role ?? "") &&
                    !string.IsNullOrWhiteSpace(element.Label) && !Commits(element.Label))
                {
                    return null;
                }
                var step = new Step { Kind = kind, Text = element == null ? null : element.Label, Role = element == null ? null : element.Role, WindowId = windowId };
                if (element != null && element.HasFrame)
                {
                    step.X = element.X;
                    step.Y = element.Y;
                    step.Width = element.Width;
                    step.Height = element.Height;
                    step.HasPlace = true;
                }
                return step;
            }
            var bare = new Step { Kind = kind, Text = null, WindowId = windowId };
            Place(bare, latest(windowId), Number(args, "x"), Number(args, "y"));
            return bare;
        }

        /// <summary>A point in the latest screenshot's pixels, as a small rectangle on the screen.</summary>
        static void Place(Step step, Snapshot read, double? x, double? y)
        {
            if (read == null || !x.HasValue || !y.HasValue || read.ShotWidth <= 0 || read.ShotHeight <= 0) return;
            double sx = read.WindowX + x.Value * read.WindowWidth / read.ShotWidth;
            double sy = read.WindowY + y.Value * read.WindowHeight / read.ShotHeight;
            step.X = sx - 4;
            step.Y = sy - 4;
            step.Width = 8;
            step.Height = 8;
            step.HasPlace = true;
        }

        static double? Number(Dictionary<string, object> args, string key)
        {
            object value;
            if (!args.TryGetValue(key, out value) || value == null) return null;
            try { return Convert.ToDouble(value); } catch (Exception) { return null; }
        }

        static long WindowOf(Dictionary<string, object> args)
        {
            object value;
            if (args.TryGetValue("window_id", out value)) return Convert.ToInt64(value);
            var target = args.ContainsKey("target") ? args["target"] as Dictionary<string, object> : null;
            if (target != null && target.TryGetValue("window_id", out value)) return Convert.ToInt64(value);
            return 0;
        }
    }
}
