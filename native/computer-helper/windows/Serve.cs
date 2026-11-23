// The warm helper: requests on stdin, answers on stdout, one JSON object per line, each answer
// carrying its request's id. It runs while a computer use session needs it and exits when stdin
// closes.

using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Kite.ComputerHelper
{
    static class Serve
    {
        const int MaxLine = 64 * 1024 * 1024;
        const int MaxPids = 1024;

        static readonly object WriteLock = new object();
        static StreamWriter output;

        public static int Run()
        {
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.AutoFlush = true;
            var input = new BufferedStream(Console.OpenStandardInput(), 1 << 16);
            var pending = new CountdownEvent(1);
            string line;
            while ((line = LineReader.Read(input, MaxLine)) != null)
            {
                if (line.Length == 0) continue;
                string request = line;
                pending.AddCount();
                ThreadPool.QueueUserWorkItem(delegate
                {
                    try { Handle(request); }
                    finally { pending.Signal(); }
                });
            }
            pending.Signal();
            pending.Wait(TimeSpan.FromSeconds(5));
            return 0;
        }

        static void Handle(string line)
        {
            var json = Json.Create();
            object id = null;
            try
            {
                var request = json.DeserializeObject(line) as Dictionary<string, object>;
                if (request == null) throw new ArgumentException("A request is a JSON object.");
                request.TryGetValue("id", out id);
                string op = Json.Text(request, "op");
                object result;
                if (op == "whoami") result = WhoAmI();
                else if (op == "elevation") result = Elevation(request);
                else if (op == "ocr") result = Ocr.Recognize(request);
                else if (op == "process") result = ProcessInfo(request);
                else if (op == "layout") result = LayoutState(request);
                else if (op == "install") result = Install(request);
                else if (op == "uninstall") result = Uninstall(request);
                else if (op == "elevate") result = Elevate(request);
                else if (Build.Test && (op == "guard" || op == "protected" || op == "stage" || op == "unstage")) result = TestOp(op, request);
                else throw new ArgumentException("Unknown op " + op + ".");
                Write(json, new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } });
            }
            catch (Exception error)
            {
                Exception inner = error is AggregateException ? error.GetBaseException() : error;
                Write(json, new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", inner.Message } });
            }
        }

        static void Write(JavaScriptSerializer json, object answer)
        {
            string text = json.Serialize(answer);
            lock (WriteLock)
            {
                output.Write(text);
                output.Write('\n');
            }
        }

        static object WhoAmI()
        {
            int? integrity;
            bool? elevated;
            Native.TokenLevel(Native.GetCurrentProcess(), out integrity, out elevated);
            return new Dictionary<string, object>
            {
                { "sid", Native.ProcessUser(Process.GetCurrentProcess().Id) },
                { "pid", Process.GetCurrentProcess().Id },
                { "integrity", integrity },
                { "elevated", elevated },
            };
        }

        static object Elevation(Dictionary<string, object> request)
        {
            object raw;
            var list = request.TryGetValue("pids", out raw) ? raw as IList : null;
            if (list == null || list.Count > MaxPids) throw new ArgumentException("pids lists up to " + MaxPids + " process ids.");
            int? self;
            bool? selfElevated;
            Native.TokenLevel(Native.GetCurrentProcess(), out self, out selfElevated);
            var pids = new Dictionary<string, object>();
            foreach (object item in list)
            {
                long pid = Json.Integer(item, "pid");
                if (pid <= 0 || pid > int.MaxValue) continue;
                int? integrity;
                bool? elevated;
                Native.ProcessLevel((int)pid, out integrity, out elevated);
                pids[pid.ToString()] = new Dictionary<string, object> { { "integrity", integrity }, { "elevated", elevated } };
            }
            return new Dictionary<string, object> { { "self", self }, { "selfElevated", selfElevated }, { "pids", pids } };
        }

        static object ProcessInfo(Dictionary<string, object> request)
        {
            long pid = Json.Integer(request, "pid");
            if (pid <= 0 || pid > int.MaxValue) throw new ArgumentException("pid must be a process id.");
            long started = Native.StartedAt((int)pid);
            return new Dictionary<string, object>
            {
                { "image", Native.ImageOf((int)pid) },
                { "started", started == 0 ? null : started.ToString() },
            };
        }

        static object LayoutState(Dictionary<string, object> request)
        {
            return Layout.State(Layout.InstallDir(Json.OptionalText(request, "installDir")), Json.OptionalText(request, "client"));
        }

        /// <summary>
        /// Copies the helper and the driver into the install folder at the owner's request, through
        /// the administrator prompt for Windows' own cmd.exe, which writes the record of their hashes
        /// and runs robocopy, while the staged files stay held: its state after (tampered when the
        /// installed files are not the recorded ones), the copy's exit code, or cancelled when the
        /// owner said no.
        /// </summary>
        static object Install(Dictionary<string, object> request)
        {
            string other = Json.OptionalText(request, "installDir");
            string dir = Layout.InstallDir(other);
            string client = Json.OptionalText(request, "client");
            if (client == null || !ValidClient(client)) throw new ArgumentException("client must name Kite's program.");
            string unsafeReason = Guard.Unsafe();
            if (unsafeReason != null) throw new InvalidOperationException(unsafeReason);
            if (Directory.Exists(dir) && !Layout.PlainDirectory(dir)) throw new InvalidOperationException("The install folder is a link.");
            using (Staged staged = Staged.Fill(client))
            {
                // One elevated command: make the folder, write the record of what should land, then
                // copy. The record's hashes are fixed in this line, which is what the owner approves.
                string robocopy = Path.Combine(Guard.SystemDir(), "robocopy.exe");
                string record = Path.Combine(dir, Layout.RecordFile);
                var line = new StringBuilder();
                line.Append("mkdir ").Append(CmdQuote(dir)).Append(" 2>nul & ");
                line.Append('>').Append(CmdQuote(record)).Append(" echo ").Append(Layout.RecordLine(staged.Record)).Append("& ");
                line.Append(CmdQuote(robocopy)).Append(' ').Append(CmdQuote(staged.Dir)).Append(' ').Append(CmdQuote(dir));
                line.Append(' ').Append(Layout.HelperFile).Append(' ').Append(Layout.DriverFile);
                // Contents and times only, so the copies take the install folder's rights; no links
                // followed into folders, no retries, nothing printed.
                line.Append(" /COPY:DT /DCOPY:T /XJ /IS /IT /R:0 /W:0 /NP /NJH /NJS /NFL /NDL");
                Launched process;
                try
                {
                    process = Shell.Start(CmdPath(), "/d /e:on /v:off /s /c \"" + line + "\"");
                }
                catch (Win32Exception error)
                {
                    if (error.NativeErrorCode == Shell.ErrorCancelled) return Cancelled(dir, client);
                    throw;
                }
                using (process)
                {
                    if (!process.WaitForExit(10 * 60 * 1000)) throw new TimeoutException("The administrator helper's install took too long.");
                    // The exit code is robocopy's, the last command's; codes below 8 are successes.
                    int code = process.ExitCode;
                    var state = Layout.State(dir, client);
                    state["exitCode"] = code < 8 ? 0 : code;
                    // Checked whatever robocopy said: a copy that failed on one file is not this install.
                    if (!staged.Landed(dir) && (string)state["state"] == "current") state["state"] = "outdated";
                    return state;
                }
            }
        }

        /// <summary>
        /// Removes the install folder through the administrator prompt for Windows' own cmd.exe. No
        /// .NET program runs for it, so no .NET setting stops it: removal always stays possible.
        /// </summary>
        static object Uninstall(Dictionary<string, object> request)
        {
            string other = Json.OptionalText(request, "installDir");
            string dir = Layout.InstallDir(other);
            if (!Directory.Exists(dir)) return Layout.State(dir, null);
            if (!Layout.PlainDirectory(dir)) throw new InvalidOperationException("The install folder is a link.");
            Launched process;
            try
            {
                // rd takes links inside away without following them.
                process = Shell.Start(CmdPath(), "/d /e:on /v:off /s /c \"rd /s /q " + CmdQuote(dir) + "\"");
            }
            catch (Win32Exception error)
            {
                if (error.NativeErrorCode == Shell.ErrorCancelled) return Cancelled(dir, null);
                throw;
            }
            using (process)
            {
                if (!process.WaitForExit(10 * 60 * 1000)) throw new TimeoutException("The administrator helper's removal took too long.");
                var state = Layout.State(dir, null);
                state["exitCode"] = process.ExitCode;
                return state;
            }
        }

        static Dictionary<string, object> Cancelled(string dir, string client)
        {
            var state = Layout.State(dir, client);
            state["cancelled"] = true;
            return state;
        }

        static bool ValidClient(string path)
        {
            return path.Length < 32768 && Path.IsPathRooted(path) &&
                path.IndexOfAny(new[] { '\r', '\n', '"' }) < 0 &&
                string.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase) &&
                File.Exists(path);
        }

        /// <summary>Launchers the prompt started, held so their ids stay theirs while connect checks the broker's parent.</summary>
        static readonly List<KeyValuePair<DateTime, Launched>> Launchers = new List<KeyValuePair<DateTime, Launched>>();

        /// <summary>
        /// Starts the installed broker through the administrator prompt, for one approved program:
        /// only the installed copy, only while its files are the recorded ones and only
        /// administrators may change them, held open while it starts, and only when no .NET setting
        /// would load code into it. The prompt starts Windows' own cmd.exe, which is no .NET program;
        /// it clears the code-loading names it can name, sets SystemRoot, windir, PATH and TEMP from
        /// the system and the install folder and starts the broker, which checks again. The answer's
        /// pid is that launcher's, the broker's parent.
        /// </summary>
        static object Elevate(Dictionary<string, object> request)
        {
            var options = BrokerOptions.FromRequest(request);
            string dir = Layout.InstallDir(options.InstallDir);
            string hostImage = Native.ImageOf(options.Host);
            var state = Layout.State(dir, hostImage);
            if ((string)state["state"] != "current") throw new InvalidOperationException("The administrator helper is not installed for this Kite, or is out of date or changed.");
            string image = Native.ImageOf(options.Target);
            if (image == null || !string.Equals(image, options.TargetImage, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The process is not the program that was approved.");
            if (Broker.StartsPrograms(image)) throw new InvalidOperationException("That program starts other programs, which the administrator helper never drives.");
            if (!Build.Test && !Native.IsHigh(options.Target)) throw new InvalidOperationException("That program does not run as administrator.");
            if (Native.Descendants(options.Target).Count > 0)
                throw new InvalidOperationException("That program has programs of its own running, which the administrator helper could not hold back; close them first.");
            string unsafeReason = Guard.Unsafe();
            if (unsafeReason != null) throw new InvalidOperationException(unsafeReason);
            string installed = Path.Combine(dir, Layout.HelperFile);
            Record record = Layout.ReadRecord(dir);
            string line = LauncherArguments(installed, options.ToArguments(), Path.Combine(dir, Layout.HomeFolder, "Temp"));
            using (FileStream held = Layout.Hold(installed))
            using (FileStream driver = Layout.Hold(Path.Combine(dir, Layout.DriverFile)))
            {
                if (record == null || Layout.Sha256(held) != record.HelperSha256 || Layout.Sha256(driver) != record.DriverSha256)
                    throw new InvalidOperationException("The installed administrator helper changed.");
                try
                {
                    Launched launcher = Shell.Start(CmdPath(), line);
                    Keep(launcher);
                    return new Dictionary<string, object> { { "pid", launcher.Id } };
                }
                catch (Win32Exception error)
                {
                    if (error.NativeErrorCode == Shell.ErrorCancelled) return new Dictionary<string, object> { { "cancelled", true } };
                    throw;
                }
            }
        }

        /// <summary>
        /// cmd.exe's line: no AutoRun (/d), no delayed expansion, the code-loading names cleared,
        /// SystemRoot, windir and PATH from the system and TEMP in the install folder, then the broker.
        /// </summary>
        static string LauncherArguments(string broker, string arguments, string temp)
        {
            string windows = Guard.WindowsDir();
            CheckCmdText(arguments);
            var line = new StringBuilder();
            foreach (string name in Guard.Cleared) line.Append("set \"").Append(name).Append("=\" & ");
            line.Append("set \"SystemRoot=").Append(CmdText(windows)).Append("\" & ");
            line.Append("set \"windir=").Append(CmdText(windows)).Append("\" & ");
            line.Append("set \"PATH=").Append(CmdText(Guard.SystemDir())).Append("\" & ");
            line.Append("set \"TEMP=").Append(CmdText(temp)).Append("\" & ");
            line.Append("set \"TMP=").Append(CmdText(temp)).Append("\" & ");
            line.Append(CmdQuote(broker)).Append(' ').Append(arguments);
            return "/d /e:on /v:off /s /c \"" + line + "\"";
        }

        /// <summary>
        /// Text cmd.exe would read as more than itself is refused: % expands even inside quotes, and
        /// a quote or control character would end or bend the line.
        /// </summary>
        static void CheckCmdText(string text)
        {
            foreach (char c in text)
            {
                if (c == '%' || char.IsControl(c)) throw new ArgumentException("A path holds a character the administrator prompt cannot pass on.");
            }
        }

        static string CmdText(string text)
        {
            CheckCmdText(text);
            if (text.IndexOf('"') >= 0) throw new ArgumentException("A path holds a character the administrator prompt cannot pass on.");
            return text;
        }

        static string CmdQuote(string path)
        {
            return Quote(CmdText(path));
        }

        static string CmdPath()
        {
            return Path.Combine(Guard.SystemDir(), "cmd.exe");
        }

        static string Quote(string path)
        {
            if (path.IndexOf('"') >= 0 || path.EndsWith("\\")) throw new ArgumentException("A path cannot be passed on.");
            return "\"" + path + "\"";
        }

        static void Keep(Launched launcher)
        {
            lock (Launchers)
            {
                DateTime now = DateTime.UtcNow;
                for (int i = Launchers.Count - 1; i >= 0; i--)
                {
                    if ((now - Launchers[i].Key).TotalMinutes < 5) continue;
                    Launchers[i].Value.Dispose();
                    Launchers.RemoveAt(i);
                }
                Launchers.Add(new KeyValuePair<DateTime, Launched>(now, launcher));
            }
        }

        static Staged testStaged;

        /// <summary>
        /// A test build's own ops: the environment check, whether a folder is admin-only, and a staged
        /// copy held as the install holds it until robocopy is done.
        /// </summary>
        static object TestOp(string op, Dictionary<string, object> request)
        {
            if (op == "guard") return new Dictionary<string, object> { { "unsafe", Guard.Unsafe() } };
            if (op == "stage")
            {
                testStaged = Staged.Fill(Json.Text(request, "client"));
                return new Dictionary<string, object> { { "dir", testStaged.Dir } };
            }
            if (op == "unstage")
            {
                if (testStaged != null) testStaged.Dispose();
                testStaged = null;
                return new Dictionary<string, object>();
            }
            return new Dictionary<string, object> { { "protected", Layout.Protected(Json.Text(request, "path")) } };
        }
    }

    /// <summary>Reads one line of UTF-8 bytes, without its line break; null at the end.</summary>
    static class LineReader
    {
        public static string Read(Stream stream, int max)
        {
            var bytes = new MemoryStream();
            while (true)
            {
                int b = stream.ReadByte();
                if (b < 0) return bytes.Length == 0 ? null : Decode(bytes);
                if (b == '\n') return Decode(bytes);
                if (bytes.Length >= max) throw new InvalidDataException("A line is longer than " + max + " bytes.");
                bytes.WriteByte((byte)b);
            }
        }

        static string Decode(MemoryStream bytes)
        {
            int length = (int)bytes.Length;
            byte[] buffer = bytes.GetBuffer();
            if (length > 0 && buffer[length - 1] == '\r') length--;
            return Encoding.UTF8.GetString(buffer, 0, length);
        }
    }

    static class Json
    {
        public static JavaScriptSerializer Create()
        {
            return new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
        }

        public static string Text(Dictionary<string, object> o, string key)
        {
            object value;
            if (!o.TryGetValue(key, out value) || !(value is string)) throw new ArgumentException(key + " must be text.");
            return (string)value;
        }

        public static string OptionalText(Dictionary<string, object> o, string key)
        {
            object value;
            if (!o.TryGetValue(key, out value) || value == null) return null;
            if (!(value is string)) throw new ArgumentException(key + " must be text.");
            return (string)value;
        }

        public static long Integer(object value, string key)
        {
            if (value is int) return (int)value;
            if (value is long) return (long)value;
            if (value is decimal && decimal.Truncate((decimal)value) == (decimal)value) return (long)(decimal)value;
            throw new ArgumentException(key + " must be a whole number.");
        }

        public static long Integer(Dictionary<string, object> o, string key)
        {
            object value;
            if (!o.TryGetValue(key, out value)) throw new ArgumentException(key + " is needed.");
            return Integer(value, key);
        }
    }
}
