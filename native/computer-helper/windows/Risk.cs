// Which steps in an app run as administrator the owner confirms in the broker's own window, and
// which the broker refuses outright. Every acting step is confirmed but those plainly harmless:
//
// - A click is harmless only on an element the snapshot that gave its token names, of a role that
//   only focuses or selects, with one plain left click and a label that commits nothing. Every other
//   click is confirmed with the window and a red box at its place; one with no place to show, such
//   as a point with no read of the window to map it, is refused.
// - Typing is harmless only into the edit field the last step clicked (no element token, or that
//   field's), with no line break or tab; anything else typed is confirmed and shown in full, and
//   text too long to show is refused.
// - Keys but moving about are confirmed. Pasting is refused by every route the broker can tell,
//   since the owner cannot see what it puts in, a list of files included: its shortcuts, a menu item
//   or a click on an element named Paste in the languages below, and a key or typed text while a
//   context menu is open, which picks an item by its letter; such a menu's items are clicked, so
//   their names are checked. Drags (both ends shown) and menus are confirmed.
// - Reading and scrolling are not confirmed. Whatever went through unconfirmed is listed in the
//   next confirmation, so it shows what the step commits.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
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

    /// <summary>A rectangle on the screen a step aims at.</summary>
    struct Place
    {
        public double X, Y, Width, Height;
    }

    /// <summary>Where the last steps left the program, as the next step's rules need it.</summary>
    sealed class Focus
    {
        /// <summary>The window whose edit field the last step clicked, or 0.</summary>
        public long Edit;
        /// <summary>That field's element token.</summary>
        public string EditToken;
        /// <summary>The last step opened a context menu, which a letter or Enter would pick from.</summary>
        public bool MenuOpen;
    }

    /// <summary>A step the owner confirms, or one the broker refuses: what it does, in words, and where.</summary>
    sealed class Step
    {
        public string Kind;
        public string Text;
        public string Role;
        public long WindowId;
        /// <summary>The screen rectangles the step aims at: one, or a drag's two ends.</summary>
        public readonly List<Place> Places = new List<Place>();
        /// <summary>Why the broker refuses the step without asking; null when it asks.</summary>
        public string Refusal;
        /// <summary>Allowed, the step opens a context menu (a right-click, the menu key, Shift+F10).</summary>
        public bool OpensMenu;
        public bool HasPlace { get { return Places.Count > 0; } }
    }

    /// <summary>What a harmless step did, for the next confirmation's list, and where it left the program.</summary>
    sealed class Assessment
    {
        /// <summary>Null when the step goes on without asking.</summary>
        public Step Step;
        /// <summary>A line for the list of what went through unconfirmed.</summary>
        public string Done;
        /// <summary>Where a step that goes on without asking leaves the program.</summary>
        public Focus Next = new Focus();
    }

    static class Risk
    {
        /// <summary>The longest text typed as administrator: what the owner's window can show in full.</summary>
        public const int MaxText = 1000;

        static readonly HashSet<string> BenignRoles = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "Edit", "TabItem", "Tab", "TreeItem", "ListItem", "ScrollBar", "Header", "HeaderItem",
            "StatusBar", "ToolTip",
        };

        static readonly HashSet<string> MovingKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "tab", "escape", "esc", "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
            "arrowup", "arrowdown", "arrowleft", "arrowright",
        };

        public static readonly HashSet<string> ModifierNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "cmd", "ctrl", "alt", "shift",
        };

        static readonly HashSet<string> NamedKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "return", "enter", "tab", "escape", "esc", "space", "backspace", "delete", "del", "forwarddelete",
            "insert", "ins", "home", "end", "pageup", "pagedown", "page_up", "page_down", "up", "down", "left",
            "right", "arrowup", "arrowdown", "arrowleft", "arrowright", "menu", "apps",
        };

        /// <summary>Whether a key is one the broker passes on: a named key, F1 to F24, or one printable ASCII character.</summary>
        public static bool KnownKey(string key)
        {
            if (string.IsNullOrEmpty(key) || key.Length > 30) return false;
            if (NamedKeys.Contains(key) || ModifierNames.Contains(key)) return true;
            if (Regex.IsMatch(key, @"\A[fF]([1-9]|1[0-9]|2[0-4])\z")) return true;
            return key.Length == 1 && key[0] > ' ' && key[0] < 0x7f;
        }

        static readonly Regex CommitWords = new Regex(
            @"\b(ok|yes|apply|delete|remove|uninstall|install|format|erase|wipe|reset|run|execute|start|launch|open|submit|confirm|save|overwrite|replace|allow|accept|agree|continue|next|finish|end task|kill|shut down|restart|update|upgrade|change|disable|enable|grant|add|create|new|import|send|copy|move|rename|set|ja|oui|sí|si|löschen|entfernen|ausführen|übernehmen|speichern|weiter|supprimer|exécuter|appliquer|enregistrer|eliminar|ejecutar|aplicar|guardar)\b",
            RegexOptions.IgnoreCase);

        static readonly string[] CommitWide =
        {
            "确定", "确认", "应用", "删除", "移除", "卸载", "安装", "格式化", "清除", "清空", "重置", "运行", "执行",
            "开始", "启动", "打开", "提交", "保存", "覆盖", "替换", "允许", "接受", "同意", "继续", "下一步", "完成",
            "结束", "关机", "重启", "更新", "升级", "更改", "禁用", "启用", "授权", "添加", "新建", "导入", "发送",
            "复制", "移动", "重命名", "设置", "是", "好", "確定", "確認", "刪除", "執行", "啟動", "開啟", "儲存",
            "削除", "実行", "適用", "保存", "開始", "はい", "続行", "삭제", "실행", "적용", "저장", "확인", "예",
        };

        static readonly Regex PasteWords = new Regex(
            @"\b(paste|einfügen|coller|pegar|incolla)\b|粘贴|粘貼|贴上|貼上|黏贴|黏貼|貼り付け|ペースト|붙여넣기",
            RegexOptions.IgnoreCase);

        /// <summary>Whether a menu item's or element's name reads as Paste.</summary>
        public static bool Pastes(string label)
        {
            if (string.IsNullOrWhiteSpace(label)) return false;
            return PasteWords.IsMatch(Regex.Replace(label, @"\(&\w\)|&", ""));
        }

        public static bool Commits(string label)
        {
            if (string.IsNullOrWhiteSpace(label)) return false;
            string text = Regex.Replace(label, @"\(&\w\)|&", "").Trim();
            return CommitWords.IsMatch(text) || CommitWide.Any(w => text.Contains(w));
        }

        /// <summary>
        /// What a tool call needs: nothing (with a line for the list), the owner's confirmation, or a
        /// refusal. `snapshot` finds the snapshot an element token names; `latest` the latest read of
        /// a window; `focusedEdit` the window whose edit field the last step clicked, or 0.
        /// </summary>
        public static Assessment Assess(string tool, Dictionary<string, object> args, Func<string, Snapshot> snapshot, Func<long, Snapshot> latest, Focus focus)
        {
            long windowId = WindowOf(args);
            switch (tool)
            {
                case "list_windows":
                case "get_window_state":
                    return new Assessment { Next = focus };
                case "scroll":
                    return new Assessment
                    {
                        Done = Confirm.Say("滚动 " + Text(args, "direction") + " " + Count(args, "amount", 3),
                            "Scrolled " + Text(args, "direction") + " " + Count(args, "amount", 3)),
                        Next = focus,
                    };
                case "click":
                    return Click(args, windowId, snapshot, latest);
                case "type_text":
                {
                    string text = Text(args, "text") ?? "";
                    if (text.Length > MaxText)
                        return Refuse("type", "the text is longer than " + MaxText + " characters, more than the owner's window can show in full", windowId);
                    if (focus.MenuOpen) return Refuse("type", MenuOpen, windowId);
                    bool plain = text.IndexOfAny(new[] { '\n', '\r', '\t' }) < 0;
                    // Into the field just clicked, and nowhere else: a token naming another element
                    // could focus a button whose mnemonic a letter presses.
                    string token = Text(args, "element_token");
                    bool same = token == null || token == focus.EditToken;
                    if (plain && same && focus.Edit != 0 && focus.Edit == windowId)
                        return new Assessment { Done = Confirm.Say("输入「" + Confirm.Visible(text) + "」", "Typed “" + Confirm.Visible(text) + "”"), Next = focus };
                    return Ask(new Step { Kind = "type", Text = text, WindowId = windowId });
                }
                case "press_key":
                {
                    string key = Text(args, "key") ?? "";
                    var modifiers = List(args, "modifiers");
                    if (Pastes(modifiers, key)) return Refuse("key", Paste, windowId);
                    bool menu = OpensMenu(modifiers, key);
                    if (focus.MenuOpen && !menu && !(modifiers.Count == 0 && MovingKeys.Contains(key)))
                        return Refuse("key", MenuOpen, windowId);
                    if (modifiers.Count == 0 && MovingKeys.Contains(key))
                    {
                        // Escape closes an open menu; the other moving keys only move within it.
                        bool open = focus.MenuOpen && !string.Equals(key, "escape", StringComparison.OrdinalIgnoreCase) && !string.Equals(key, "esc", StringComparison.OrdinalIgnoreCase);
                        return new Assessment { Done = Confirm.Say("按 " + key, "Pressed " + key), Next = new Focus { MenuOpen = open } };
                    }
                    var keys = new List<string>(modifiers) { key };
                    return Ask(new Step { Kind = "key", Text = string.Join("+", keys), WindowId = windowId, OpensMenu = menu });
                }
                case "hotkey":
                {
                    var keys = List(args, "keys");
                    string last = keys.Count == 0 ? "" : keys[keys.Count - 1];
                    var held = keys.Take(Math.Max(0, keys.Count - 1)).ToList();
                    if (Pastes(held, last)) return Refuse("key", Paste, windowId);
                    bool menu = OpensMenu(held, last);
                    if (focus.MenuOpen && !menu) return Refuse("key", MenuOpen, windowId);
                    return Ask(new Step { Kind = "key", Text = string.Join("+", keys), WindowId = windowId, OpensMenu = menu });
                }
                case "drag":
                {
                    var step = new Step { Kind = "drag", WindowId = windowId };
                    Snapshot read = latest(windowId);
                    Place from, to;
                    if (!Map(read, Number(args, "from_x"), Number(args, "from_y"), out from) || !Map(read, Number(args, "to_x"), Number(args, "to_y"), out to))
                        return Refuse("drag", NoPlace, windowId);
                    step.Places.Add(from);
                    step.Places.Add(to);
                    return Ask(step);
                }
                case "invoke_menu":
                {
                    var path = List(args, "path");
                    if (path.Any(Pastes)) return Refuse("menu", Paste, windowId);
                    return Ask(new Step { Kind = "menu", Text = string.Join(" > ", path), WindowId = windowId });
                }
                default:
                    return Refuse(tool, "the elevated helper does not know that step", windowId);
            }
        }

        const string Paste = "pasting puts in what is on the clipboard, text or files, which the owner cannot see, so the elevated helper never pastes";
        const string MenuOpen = "a context menu is open, where a key picks an item by its letter; click the item, or press Escape";

        /// <summary>The menu key or Shift+F10, which open a context menu.</summary>
        static bool OpensMenu(List<string> modifiers, string key)
        {
            if (modifiers.Count == 0 && (string.Equals(key, "menu", StringComparison.OrdinalIgnoreCase) || string.Equals(key, "apps", StringComparison.OrdinalIgnoreCase))) return true;
            return modifiers.Count == 1 && string.Equals(modifiers[0], "shift", StringComparison.OrdinalIgnoreCase) && string.Equals(key, "f10", StringComparison.OrdinalIgnoreCase);
        }
        const string NoPlace = "the step has no place in a read of the window to show the owner, so read the window first";

        static Assessment Ask(Step step)
        {
            return new Assessment { Step = step };
        }

        static Assessment Refuse(string kind, string why, long windowId)
        {
            return new Assessment { Step = new Step { Kind = kind, WindowId = windowId, Refusal = why } };
        }

        /// <summary>Ctrl+V, Ctrl+Shift+V and Shift+Insert, in any spelling the driver takes.</summary>
        static bool Pastes(List<string> modifiers, string key)
        {
            var held = new HashSet<string>(modifiers, StringComparer.OrdinalIgnoreCase);
            if ((held.Contains("ctrl") || held.Contains("cmd")) && string.Equals(key, "v", StringComparison.OrdinalIgnoreCase)) return true;
            return held.Contains("shift") && (string.Equals(key, "insert", StringComparison.OrdinalIgnoreCase) || string.Equals(key, "ins", StringComparison.OrdinalIgnoreCase));
        }

        static Assessment Click(Dictionary<string, object> args, long windowId, Func<string, Snapshot> snapshot, Func<long, Snapshot> latest)
        {
            string button = Text(args, "button");
            long count = Count(args, "count", 1);
            bool plain = (button == null || button == "left") && count <= 1;
            string kind = button == "right" ? "right-click" : button == "middle" ? "middle-click" : count >= 2 ? "double-click" : "click";
            string token = Text(args, "element_token");
            if (token != null)
            {
                int colon = token.IndexOf(':');
                Snapshot read = colon > 0 ? snapshot(token.Substring(0, colon)) : null;
                long row;
                Element element = null;
                if (read != null && long.TryParse(token.Substring(colon + 1), NumberStyles.None, CultureInfo.InvariantCulture, out row)) read.Elements.TryGetValue(row, out element);
                if (element == null) return Refuse(kind, NoPlace, windowId);
                if (Pastes(element.Label)) return Refuse(kind, Paste, windowId);
                if (plain && BenignRoles.Contains(element.Role ?? "") && !string.IsNullOrWhiteSpace(element.Label) && !Commits(element.Label))
                {
                    bool edit = string.Equals(element.Role, "Edit", StringComparison.OrdinalIgnoreCase);
                    return new Assessment
                    {
                        Done = Confirm.Say("点击「" + Confirm.Line(element.Label) + "」(" + element.Role + ")", "Clicked “" + Confirm.Line(element.Label) + "” (" + element.Role + ")"),
                        Next = edit ? new Focus { Edit = windowId, EditToken = token } : new Focus(),
                    };
                }
                if (!element.HasFrame) return Refuse(kind, NoPlace, windowId);
                var step = new Step { Kind = kind, Text = element.Label, Role = element.Role, WindowId = windowId, OpensMenu = kind == "right-click" };
                step.Places.Add(new Place { X = element.X, Y = element.Y, Width = element.Width, Height = element.Height });
                return Ask(step);
            }
            Place place;
            if (!Map(latest(windowId), Number(args, "x"), Number(args, "y"), out place)) return Refuse(kind, NoPlace, windowId);
            var bare = new Step { Kind = kind, WindowId = windowId, OpensMenu = kind == "right-click" };
            bare.Places.Add(place);
            return Ask(bare);
        }

        /// <summary>A point in the latest screenshot's pixels, as a small rectangle on the screen.</summary>
        static bool Map(Snapshot read, double? x, double? y, out Place place)
        {
            place = new Place();
            if (read == null || !x.HasValue || !y.HasValue || read.ShotWidth <= 0 || read.ShotHeight <= 0) return false;
            if (x.Value < 0 || y.Value < 0 || x.Value > read.ShotWidth || y.Value > read.ShotHeight) return false;
            double sx = read.WindowX + x.Value * read.WindowWidth / read.ShotWidth;
            double sy = read.WindowY + y.Value * read.WindowHeight / read.ShotHeight;
            place = new Place { X = sx - 4, Y = sy - 4, Width = 8, Height = 8 };
            return true;
        }

        static string Text(Dictionary<string, object> args, string key)
        {
            object value;
            return args.TryGetValue(key, out value) ? value as string : null;
        }

        static long Count(Dictionary<string, object> args, string key, long fallback)
        {
            object value;
            if (!args.TryGetValue(key, out value) || value == null) return fallback;
            try { return Json.Integer(value, key); } catch (ArgumentException) { return fallback; }
        }

        static List<string> List(Dictionary<string, object> args, string key)
        {
            object value;
            var list = new List<string>();
            var items = args.TryGetValue(key, out value) ? value as System.Collections.IList : null;
            if (items != null) foreach (object item in items) list.Add(item as string ?? "");
            return list;
        }

        static double? Number(Dictionary<string, object> args, string key)
        {
            object value;
            if (!args.TryGetValue(key, out value) || value == null) return null;
            if (!(value is int || value is long || value is decimal || value is double)) return null;
            return Convert.ToDouble(value, CultureInfo.InvariantCulture);
        }

        static long WindowOf(Dictionary<string, object> args)
        {
            object value;
            if (args.TryGetValue("window_id", out value)) return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            var target = args.ContainsKey("target") ? args["target"] as Dictionary<string, object> : null;
            if (target != null && target.TryGetValue("window_id", out value)) return Convert.ToInt64(value, CultureInfo.InvariantCulture);
            return 0;
        }
    }
}
