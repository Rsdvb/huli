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
using Microsoft.Win32;

namespace Kite.ComputerHelper
{
    static class Serve
    {
        const int MaxLine = 64 * 1024 * 1024;
        const int MaxPids = 1024;
        const int ErrorCancelled = 1223;

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
                else if (op == "install") result = Prompted(request, "install");
                else if (op == "uninstall") result = Prompted(request, "uninstall");
                else if (op == "elevate") result = Elevate(request);
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
        /// Installs or removes the elevated helper through the administrator prompt, which the owner
        /// answers on the secure desktop, and waits for it: its exit code and the folder's state
        /// after, or cancelled when the owner said no.
        /// </summary>
        static object Prompted(Dictionary<string, object> request, string mode)
        {
            string other = Json.OptionalText(request, "installDir");
            string dir = Layout.InstallDir(other);
            string client = Json.OptionalText(request, "client");
            var args = new StringBuilder(mode);
            if (mode == "install")
            {
                if (client == null || client.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0) throw new ArgumentException("client must name Kite's program.");
                args.Append(" --client-image \"").Append(client).Append('"');
            }
            if (other != null) args.Append(" --install-dir \"").Append(dir).Append('"');
            // Removal runs the installed copy when there is one, which only administrators can change.
            string installed = Path.Combine(dir, Layout.HelperFile);
            string program = mode == "uninstall" && File.Exists(installed) ? installed : Layout.OwnPath();
            Process process;
            try
            {
                process = Start(program, args.ToString());
            }
            catch (Win32Exception error)
            {
                if (error.NativeErrorCode == ErrorCancelled) return new Dictionary<string, object> { { "cancelled", true } };
                throw;
            }
            using (process)
            {
                if (!process.WaitForExit(10 * 60 * 1000)) throw new TimeoutException("The administrator helper's " + mode + " took too long.");
                var state = Layout.State(dir, client);
                state["exitCode"] = process.ExitCode;
                return state;
            }
        }

        /// <summary>
        /// Starts the installed broker through the administrator prompt, for one approved program:
        /// only the installed copy, only when it is this very helper and the driver it was built with,
        /// held open while it starts, and only when no .NET profiler would load into it.
        /// </summary>
        static object Elevate(Dictionary<string, object> request)
        {
            var options = BrokerOptions.FromRequest(request);
            string dir = Layout.InstallDir(options.InstallDir);
            string hostImage = Native.ImageOf(options.Host);
            var state = Layout.State(dir, hostImage);
            if ((string)state["state"] != "current") throw new InvalidOperationException("The administrator helper is not installed for this Kite, or is out of date.");
            if (Broker.Launchers.Contains(Path.GetFileName(options.TargetImage))) throw new InvalidOperationException("That program starts other programs, which the administrator helper never drives.");
            string profiling = Profiling();
            if (profiling != null) throw new InvalidOperationException("The .NET profiling variable " + profiling + " is set, which would load code into the administrator helper.");
            string installed = Path.Combine(dir, Layout.HelperFile);
            using (FileStream held = Layout.Hold(installed))
            using (FileStream driver = Layout.Hold(Path.Combine(dir, Layout.DriverFile)))
            {
                if (Layout.Sha256(held) != Layout.Sha256(Layout.OwnPath()) || Layout.Sha256(driver) != Build.DriverSha256)
                    throw new InvalidOperationException("The installed administrator helper changed.");
                try
                {
                    using (var process = Start(installed, options.ToArguments()))
                    {
                        return new Dictionary<string, object> { { "pid", process == null ? (int?)null : process.Id } };
                    }
                }
                catch (Win32Exception error)
                {
                    if (error.NativeErrorCode == ErrorCancelled) return new Dictionary<string, object> { { "cancelled", true } };
                    throw;
                }
            }
        }

        /// <summary>Through the administrator prompt; a test build starts it as it is, with no prompt.</summary>
        static Process Start(string program, string arguments)
        {
            var start = new ProcessStartInfo { FileName = program, Arguments = arguments };
            if (Build.Test)
            {
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
            }
            else
            {
                start.UseShellExecute = true;
                start.Verb = "runas";
                start.WindowStyle = ProcessWindowStyle.Hidden;
            }
            return Process.Start(start);
        }

        static readonly string[] ProfilingNames = { "COR_ENABLE_PROFILING", "COR_PROFILER", "COR_PROFILER_PATH", "COR_PROFILER_PATH_32", "COR_PROFILER_PATH_64" };

        /// <summary>
        /// A variable that makes the .NET runtime load a profiler or change itself, as this process,
        /// the user's or the machine's environment sets it; the elevated helper would inherit it.
        /// </summary>
        static string Profiling()
        {
            var names = new List<string>();
            foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) names.Add((string)entry.Key);
            foreach (var key in new[] { Registry.CurrentUser.OpenSubKey("Environment"), Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Environment") })
            {
                if (key == null) continue;
                using (key) names.AddRange(key.GetValueNames());
            }
            foreach (string name in names)
            {
                if (Array.Exists(ProfilingNames, p => string.Equals(p, name, StringComparison.OrdinalIgnoreCase))) return name;
                // COMPlus_ settings reach the .NET Framework runtime, some of them loading code (AltJit).
                if (name.StartsWith("COMPLUS_", StringComparison.OrdinalIgnoreCase)) return name;
            }
            return null;
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
