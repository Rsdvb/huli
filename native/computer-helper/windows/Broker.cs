// The elevated broker. It runs as administrator from Program Files\Kite Computer Helper only, for
// one program the owner approves, and serves one connection, then exits:
//
// - Who started it is not trusted. Its arguments name the program by process id, start time and
//   image path, which it checks, and it refuses programs that start other programs (consoles, Task
//   Manager, Explorer, script hosts and the like). The owner then confirms in its own window, which
//   names the program and the Kite program asking; no normal process can click that window.
// - Its pipe admits Kite's user alone, by the SID passed in (under Administrator protection the
//   broker runs as the shadow administrator, another account), with a medium label that keeps lower
//   integrity out of reading or writing it. The client must be this same installed helper in its
//   connect mode, started by the Kite program recorded at install (the host process named), and its
//   first line must carry the session's token, whose SHA-256 alone is on the command line.
// - While it runs, the program sits in a job that lets it start no process, so its own dialogs
//   cannot open a console as administrator; the limit is lifted when the broker ends.
// - It runs Cua Driver from its own folder, checked against the hash built in while held open, in a
//   job that ends it with the broker, with an environment of its own: home and temporary folders
//   under the install folder and a PATH of system folders without PowerShell. It relays only the
//   reading and input tools Kite uses, each scoped to a window of the approved program, with only
//   the arguments Kite sends and in the background only, as it re-serializes them, and asks the owner
//   in its own window before every step but plainly harmless ones (see Risk.cs).
// - It ends when Kite disconnects, the program or Kite's host exits, or no request came for the idle
//   time while none was pending.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Kite.ComputerHelper
{
    sealed class BrokerOptions
    {
        static readonly Regex PipePattern = new Regex(@"\Akite-computer-[0-9a-f]{32}\z");
        static readonly Regex SidPattern = new Regex(@"\AS-1-(5-21|12-1)(-[0-9]{1,10}){1,14}\z");
        static readonly Regex HashPattern = new Regex(@"\A[0-9a-f]{64}\z");
        public const int DefaultIdleMs = 10 * 60 * 1000;

        public string Pipe;
        public string User;
        public int Host;
        public int Target;
        public string TargetImage;
        public long TargetStarted;
        public string TokenSha256;
        public int IdleMs = DefaultIdleMs;
        public string Lang = "en";
        public string InstallDir;

        public static BrokerOptions FromOptions(Dictionary<string, string> values)
        {
            var o = new BrokerOptions();
            o.Pipe = Need(values, "pipe");
            o.User = Need(values, "user");
            o.Host = ParsePid(Need(values, "host"), "host");
            o.Target = ParsePid(Need(values, "target"), "target");
            o.TargetImage = Need(values, "target-image");
            long started;
            if (!long.TryParse(Need(values, "target-started"), out started) || started <= 0) throw new ArgumentException("--target-started must be a FILETIME.");
            o.TargetStarted = started;
            o.TokenSha256 = Need(values, "token-sha256");
            string text;
            if (values.TryGetValue("idle", out text)) o.IdleMs = ParseIdle(text);
            if (values.TryGetValue("lang", out text)) o.Lang = text;
            if (values.TryGetValue("install-dir", out text)) o.InstallDir = text;
            o.Validate();
            return o;
        }

        public static BrokerOptions FromRequest(Dictionary<string, object> request)
        {
            var o = new BrokerOptions();
            o.Pipe = Json.Text(request, "pipe");
            o.User = Json.Text(request, "user");
            o.Host = (int)Math.Min(int.MaxValue, Json.Integer(request, "host"));
            o.Target = (int)Math.Min(int.MaxValue, Json.Integer(request, "target"));
            o.TargetImage = Json.Text(request, "targetImage");
            long started;
            if (!long.TryParse(Json.Text(request, "targetStarted"), out started)) throw new ArgumentException("targetStarted must be a FILETIME.");
            o.TargetStarted = started;
            o.TokenSha256 = Json.Text(request, "tokenSha256");
            object idle;
            if (request.TryGetValue("idleMs", out idle) && idle != null) o.IdleMs = ParseIdle(Json.Integer(idle, "idleMs").ToString());
            o.Lang = Json.OptionalText(request, "lang") ?? "en";
            o.InstallDir = Json.OptionalText(request, "installDir");
            o.Validate();
            return o;
        }

        public string ToArguments()
        {
            var args = new StringBuilder("broker");
            Add(args, "pipe", Pipe);
            Add(args, "user", User);
            Add(args, "host", Host.ToString());
            Add(args, "target", Target.ToString());
            Add(args, "target-image", TargetImage);
            Add(args, "target-started", TargetStarted.ToString());
            Add(args, "token-sha256", TokenSha256);
            Add(args, "idle", IdleMs.ToString());
            Add(args, "lang", Lang);
            if (InstallDir != null) Add(args, "install-dir", InstallDir);
            return args.ToString();
        }

        static void Add(StringBuilder args, string name, string value)
        {
            args.Append(" --").Append(name).Append(' ');
            // Paths have no quote of their own and never end in a backslash here.
            if (value.IndexOf(' ') >= 0) args.Append('"').Append(value).Append('"');
            else args.Append(value);
        }

        void Validate()
        {
            if (!PipePattern.IsMatch(Pipe)) throw new ArgumentException("pipe must be kite-computer- and 32 hex digits.");
            if (!SidPattern.IsMatch(User)) throw new ArgumentException("user must be an account SID.");
            if (!HashPattern.IsMatch(TokenSha256)) throw new ArgumentException("token-sha256 must be 64 hex digits.");
            if (Host <= 0 || Target <= 0) throw new ArgumentException("host and target must be process ids.");
            if (!Path.IsPathRooted(TargetImage) || TargetImage.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0 || TargetImage.EndsWith("\\"))
                throw new ArgumentException("target-image must be a full path.");
            if (Lang != "zh-CN" && Lang != "en") throw new ArgumentException("lang must be zh-CN or en.");
            if (InstallDir != null && (!Build.Test || InstallDir.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0 || InstallDir.EndsWith("\\")))
                throw new ArgumentException("install-dir is for test builds.");
        }

        static string Need(Dictionary<string, string> values, string key)
        {
            string value;
            if (!values.TryGetValue(key, out value) || value.Length == 0) throw new ArgumentException("--" + key + " is needed.");
            return value;
        }

        static int ParsePid(string text, string key)
        {
            int pid;
            if (!int.TryParse(text, out pid) || pid <= 0) throw new ArgumentException("--" + key + " must be a process id.");
            return pid;
        }

        static int ParseIdle(string text)
        {
            int ms;
            if (!int.TryParse(text, out ms)) throw new ArgumentException("idle must be milliseconds.");
            return Math.Max(5000, Math.Min(30 * 60 * 1000, ms));
        }
    }

    static class Broker
    {
        /// <summary>Programs that start other programs, which the broker never drives.</summary>
        public static readonly HashSet<string> Launchers = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "taskmgr.exe", "cmd.exe", "powershell.exe", "powershell_ise.exe", "pwsh.exe", "windowsterminal.exe",
            "wt.exe", "openconsole.exe", "conhost.exe", "regedit.exe", "regedt32.exe", "mmc.exe", "explorer.exe",
            "rundll32.exe", "mshta.exe", "wscript.exe", "cscript.exe", "msiexec.exe", "control.exe",
        };

        public static int Run(Dictionary<string, string> values)
        {
            BrokerOptions options;
            try
            {
                options = BrokerOptions.FromOptions(values);
            }
            catch (ArgumentException error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }
            Confirm.Chinese = options.Lang == "zh-CN";
            string own = Layout.OwnPath();
            string dir = Path.GetDirectoryName(own);
            if (!Layout.SamePath(dir, Layout.InstallDir(options.InstallDir))) return Fail(13, "The broker runs only from its install folder.");
            if (!Build.Test && !Native.SelfIsHigh()) return Fail(9, "The broker runs as administrator only.");
            string recorded = Path.Combine(dir, Layout.ClientFile);
            if (!File.Exists(recorded)) return Fail(6, "The install records no Kite program.");
            string client = File.ReadAllText(recorded, Encoding.UTF8).Trim();
            if (Launchers.Contains(Path.GetFileName(options.TargetImage))) return Fail(8, "That program starts other programs, which the broker never drives.");
            Process target, host;
            try
            {
                target = Process.GetProcessById(options.Target);
                host = Process.GetProcessById(options.Host);
                // Holding the handles keeps both ids from going to another process.
                var unused = target.Handle;
                unused = host.Handle;
            }
            catch (Exception)
            {
                return Fail(7, "The approved program or Kite is not running.");
            }
            if (!Layout.SamePath(Native.ImageOf(options.Target), options.TargetImage) || Native.StartedAt(options.Target) != options.TargetStarted)
                return Fail(7, "The process is not the program that was approved.");
            if (!Layout.SamePath(Native.ImageOf(options.Host), client)) return Fail(7, "The host is not the Kite program the install recorded.");
            Native.SetProcessDPIAware();
            return new Session(options, own, client, target, host).Run();
        }

        static int Fail(int code, string message)
        {
            Console.Error.WriteLine(message);
            return code;
        }

        sealed class Session
        {
            const int ConnectWaitMs = 60000;
            const int HelloWaitMs = 10000;
            const int MaxHello = 4096;
            const int MaxRequest = 1024 * 1024;
            const int MaxReply = 96 * 1024 * 1024;
            const int MaxRefusals = 3;
            const int SnapshotsKept = 32;

            static readonly Dictionary<string, HashSet<string>> Tools = new Dictionary<string, HashSet<string>>
            {
                { "list_windows", Set("pid", "on_screen_only") },
                { "get_window_state", Set("pid", "window_id", "query", "since", "max_elements", "max_depth", "include_screenshot", "include_accessibility_tree", "tree_format") },
                { "click", Set("target", "element_token", "x", "y", "button", "count", "delivery_mode") },
                { "type_text", Set("target", "text", "element_token", "delivery_mode") },
                { "press_key", Set("target", "key", "modifiers", "delivery_mode") },
                { "hotkey", Set("target", "keys", "delivery_mode") },
                { "scroll", Set("target", "x", "y", "direction", "amount", "by", "delivery_mode") },
                { "drag", Set("target", "from_x", "from_y", "to_x", "to_y", "button", "modifier", "duration_ms", "steps", "delivery_mode") },
                { "invoke_menu", Set("pid", "window_id", "path", "delivery_mode") },
            };
            static readonly HashSet<string> Acting = Set("click", "type_text", "press_key", "hotkey", "scroll", "drag", "invoke_menu");
            static readonly HashSet<string> PlainMethods = Set("initialize", "notifications/initialized", "notifications/cancelled", "ping", "tools/list");
            static readonly HashSet<string> MessageKeys = Set("jsonrpc", "id", "method", "params");
            static readonly HashSet<string> CallKeys = Set("name", "arguments", "_meta");

            static HashSet<string> Set(params string[] items)
            {
                return new HashSet<string>(items, StringComparer.Ordinal);
            }

            readonly BrokerOptions options;
            readonly string own;
            readonly string client;
            readonly Process target;
            readonly Process host;
            readonly JavaScriptSerializer json = Json.Create();
            readonly SemaphoreSlim writeLock = new SemaphoreSlim(1, 1);
            readonly TaskCompletionSource<string> ended = new TaskCompletionSource<string>();
            readonly object pendingLock = new object();
            readonly Dictionary<string, string> pending = new Dictionary<string, string>();
            readonly Dictionary<string, Snapshot> snapshots = new Dictionary<string, Snapshot>();
            readonly Queue<string> snapshotOrder = new Queue<string>();
            readonly Dictionary<long, Snapshot> latest = new Dictionary<long, Snapshot>();
            NamedPipeServerStream pipe;
            Process driver;
            IntPtr driverJob = IntPtr.Zero;
            IntPtr targetJob = IntPtr.Zero;
            Timer idle;

            public Session(BrokerOptions options, string own, string client, Process target, Process host)
            {
                this.options = options;
                this.own = own;
                this.client = client;
                this.target = target;
                this.host = host;
            }

            public int Run()
            {
                SafePipeHandle handle = CreatePipe();
                if (handle == null) return 3;
                pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, handle);
                try
                {
                    int code = Accept();
                    if (code != 0) return code;
                    target.Refresh();
                    if (!Confirm.Start(options.TargetImage, options.Target, target.MainWindowTitle, client))
                        return Refuse(14, "the user did not allow it");
                    if (!Contain()) return Refuse(15, "the program could not be kept from starting other programs");
                    string failure = StartDriver();
                    if (failure != null) return Refuse(16, failure);
                    Send(new Dictionary<string, object> { { "ok", true }, { "pid", Process.GetCurrentProcess().Id } });
                    WatchExit(target, "the approved program exited");
                    WatchExit(host, "Kite's host exited");
                    WatchExit(driver, "Cua Driver exited");
                    idle = new Timer(delegate { End("idle"); }, null, options.IdleMs, Timeout.Infinite);
                    Requests().ContinueWith(done => End(Reason("Kite disconnected", done)));
                    Replies().ContinueWith(done => End(Reason("Cua Driver closed its output", done)));
                    ended.Task.Wait();
                    Console.Error.WriteLine("Broker ended: " + ended.Task.Result);
                    return 0;
                }
                finally
                {
                    Stop();
                }
            }

            int Refuse(int code, string reason)
            {
                try { Send(new Dictionary<string, object> { { "ok", false }, { "error", reason } }); } catch (Exception) { }
                return code;
            }

            SafePipeHandle CreatePipe()
            {
                string sddl = "D:P(A;;GRGW;;;" + options.User + ")S:(ML;;NWNR;;;ME)";
                IntPtr descriptor;
                if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out descriptor, IntPtr.Zero))
                {
                    Console.Error.WriteLine(Native.LastError("The pipe's security descriptor").Message);
                    return null;
                }
                try
                {
                    var attributes = new Native.SECURITY_ATTRIBUTES
                    {
                        nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)),
                        lpSecurityDescriptor = descriptor,
                        bInheritHandle = 0,
                    };
                    SafePipeHandle handle = Native.CreateNamedPipeW(
                        @"\\.\pipe\" + options.Pipe,
                        Native.PIPE_ACCESS_DUPLEX | Native.FILE_FLAG_FIRST_PIPE_INSTANCE | Native.FILE_FLAG_OVERLAPPED,
                        Native.PIPE_TYPE_BYTE | Native.PIPE_READMODE_BYTE | Native.PIPE_WAIT | Native.PIPE_REJECT_REMOTE_CLIENTS,
                        1, 1 << 16, 1 << 16, 0, ref attributes);
                    if (handle.IsInvalid)
                    {
                        Console.Error.WriteLine(Native.LastError("The pipe").Message);
                        return null;
                    }
                    return handle;
                }
                finally
                {
                    Native.LocalFree(descriptor);
                }
            }

            /// <summary>Waits for Kite: 0 once it proved itself, else the exit code.</summary>
            int Accept()
            {
                var deadline = DateTime.UtcNow.AddMilliseconds(ConnectWaitMs);
                for (int refusals = 0; refusals < MaxRefusals; )
                {
                    var wait = Task.Factory.FromAsync(pipe.BeginWaitForConnection, pipe.EndWaitForConnection, null);
                    int left = (int)Math.Max(0, (deadline - DateTime.UtcNow).TotalMilliseconds);
                    if (!wait.Wait(left)) return 4;
                    Task<string> read;
                    string refusal = Check(out read);
                    if (refusal == null) return 0;
                    try
                    {
                        Send(new Dictionary<string, object> { { "ok", false }, { "error", refusal } });
                        pipe.WaitForPipeDrain();
                    }
                    catch (Exception)
                    {
                        // A client that went away needs no answer.
                    }
                    pipe.Disconnect();
                    // A read still waiting for that client fails now; the next one starts clean.
                    if (read != null)
                    {
                        try { read.Wait(2000); } catch (Exception) { }
                    }
                    readStart = readEnd = 0;
                    refusals++;
                }
                return 5;
            }

            /// <summary>Why the connected client is refused, or null when it is Kite's connect.</summary>
            string Check(out Task<string> read)
            {
                read = null;
                int pid;
                if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid)) return "not the expected process";
                if (!Layout.SamePath(Native.ImageOf(pid), own)) return "not the expected program";
                if (Native.ParentOf(pid) != options.Host || Native.StartedAt(pid) < Native.StartedAt(options.Host))
                    return "not the expected process";
                string user = Native.ProcessUser(pid);
                if (user == null || !string.Equals(user, options.User, StringComparison.OrdinalIgnoreCase))
                    return "not the expected account";
                string line;
                read = ReadLine(MaxHello);
                try
                {
                    if (!read.Wait(HelloWaitMs)) return "no token in time";
                    line = read.Result;
                }
                catch (Exception)
                {
                    return "no token";
                }
                if (line == null) return "no token";
                Dictionary<string, object> hello;
                try
                {
                    hello = json.DeserializeObject(line) as Dictionary<string, object>;
                }
                catch (Exception)
                {
                    return "no token";
                }
                object token;
                if (hello == null || !hello.TryGetValue("token", out token) || !(token is string)) return "no token";
                byte[] actual;
                using (var sha = SHA256.Create())
                {
                    actual = sha.ComputeHash(Encoding.UTF8.GetBytes((string)token));
                }
                return SameHash(actual, options.TokenSha256) ? null : "wrong token";
            }

            static bool SameHash(byte[] actual, string expectedHex)
            {
                var hex = new StringBuilder(actual.Length * 2);
                foreach (byte b in actual) hex.Append(b.ToString("x2"));
                string a = hex.ToString();
                int difference = a.Length ^ expectedHex.Length;
                for (int i = 0; i < a.Length && i < expectedHex.Length; i++) difference |= a[i] ^ expectedHex[i];
                return difference == 0;
            }

            /// <summary>Puts the program in a job that lets it start no process while the broker runs.</summary>
            bool Contain()
            {
                targetJob = Native.CreateJobObjectW(IntPtr.Zero, null);
                if (targetJob == IntPtr.Zero) return false;
                try
                {
                    if (!Native.AssignProcessToJobObject(targetJob, target.Handle)) return false;
                    Native.LimitJob(targetJob, Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS, 1);
                    return true;
                }
                catch (Exception)
                {
                    return false;
                }
            }

            /// <summary>Starts Cua Driver, or says why not.</summary>
            string StartDriver()
            {
                string dir = Path.GetDirectoryName(own);
                string path = Path.Combine(dir, Layout.DriverFile);
                string home = Path.Combine(dir, Layout.HomeFolder);
                var start = new ProcessStartInfo(path, "mcp --direct")
                {
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    WorkingDirectory = dir,
                };
                string root = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
                var env = start.EnvironmentVariables;
                env.Clear();
                env["SystemRoot"] = root;
                env["windir"] = root;
                env["SystemDrive"] = Path.GetPathRoot(root).TrimEnd('\\');
                env["ComSpec"] = Path.Combine(root, @"System32\cmd.exe");
                env["NUMBER_OF_PROCESSORS"] = Environment.ProcessorCount.ToString();
                env["PROCESSOR_ARCHITECTURE"] = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "AMD64";
                env["ProgramFiles"] = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                env["ProgramData"] = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                env["USERNAME"] = Environment.UserName;
                // Its own folders under the install folder, which only administrators write to, in
                // place of the user's profile and temporary folder, which the user can write to.
                env["USERPROFILE"] = home;
                env["HOME"] = home;
                env["LOCALAPPDATA"] = Path.Combine(home, "Local");
                env["APPDATA"] = Path.Combine(home, "Roaming");
                env["TEMP"] = Path.Combine(home, "Temp");
                env["TMP"] = Path.Combine(home, "Temp");
                env["PATH"] = root + @"\System32;" + root;
                env["PSModulePath"] = root + @"\System32\WindowsPowerShell\v1.0\Modules";
                env["CUA_DRIVER_EMBEDDED"] = "1";
                env["DO_NOT_TRACK"] = "1";
                env["CUA_DRIVER_RS_UPDATE_CHECK"] = "false";
                env["CUA_DRIVER_DISABLE_UNRESTRICTED"] = "1";
                try
                {
                    using (FileStream held = Layout.Hold(path))
                    {
                        if (Layout.Sha256(held) != Build.DriverSha256) return "cua-driver.exe is not the one this helper was built with";
                        driver = Process.Start(start);
                    }
                }
                catch (Exception error)
                {
                    return "Cua Driver did not start: " + error.Message;
                }
                driverJob = Native.CreateJobObjectW(IntPtr.Zero, null);
                if (driverJob == IntPtr.Zero || !Native.AssignProcessToJobObject(driverJob, driver.Handle))
                    return "Cua Driver could not be tied to the broker";
                Native.LimitJob(driverJob, Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0);
                // Its stderr is read and dropped so a full pipe never blocks it.
                var stderr = driver.StandardError.BaseStream;
                Task.Factory.StartNew(delegate
                {
                    var sink = new byte[4096];
                    try { while (stderr.Read(sink, 0, sink.Length) > 0) { } } catch (Exception) { }
                }, TaskCreationOptions.LongRunning);
                return null;
            }

            void WatchExit(Process process, string reason)
            {
                Task.Factory.StartNew(delegate
                {
                    try { process.WaitForExit(); } catch (Exception) { }
                    End(reason);
                }, TaskCreationOptions.LongRunning);
            }

            /// <summary>Kite's requests: each checked, confirmed when risky, then passed on re-serialized.</summary>
            async Task Requests()
            {
                Stream input = driver.StandardInput.BaseStream;
                while (true)
                {
                    string line = await ReadLine(MaxRequest);
                    if (line == null) return;
                    if (line.Trim().Length == 0) continue;
                    // No idle time runs out while a request is checked or the owner answers its window.
                    idle.Change(Timeout.Infinite, Timeout.Infinite);
                    Dictionary<string, object> message;
                    object id;
                    bool tool;
                    string name;
                    string refusal = Allowed(line, out message, out id, out tool, out name);
                    if (refusal == null && tool) refusal = Confirmed(name, Arguments(message));
                    if (refusal != null)
                    {
                        if (id != null) await SendAsync(tool ? Refused(id, refusal) : Unavailable(id, refusal));
                        RearmIdle();
                        continue;
                    }
                    if (id != null)
                    {
                        lock (pendingLock) pending[Key(id)] = name ?? "";
                    }
                    // What passes is what was checked: the parsed message, written anew.
                    byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(message) + "\n");
                    await input.WriteAsync(bytes, 0, bytes.Length);
                    await input.FlushAsync();
                    RearmIdle();
                }
            }

            /// <summary>Cua Driver's answers, passed to Kite line by line; a read's elements are kept.</summary>
            async Task Replies()
            {
                Stream output = driver.StandardOutput.BaseStream;
                var buffer = new byte[1 << 16];
                var line = new MemoryStream();
                while (true)
                {
                    int read = await output.ReadAsync(buffer, 0, buffer.Length);
                    if (read <= 0)
                    {
                        // A zero-length write by the driver reads as no bytes too; only its exit ends it.
                        if (driver.HasExited) return;
                        await Task.Delay(20);
                        continue;
                    }
                    int start = 0;
                    for (int i = 0; i < read; i++)
                    {
                        if (buffer[i] != '\n') continue;
                        line.Write(buffer, start, i - start);
                        start = i + 1;
                        await Reply(line.ToArray());
                        line.SetLength(0);
                    }
                    line.Write(buffer, start, read - start);
                    if (line.Length > MaxReply) throw new InvalidDataException("An answer is too long.");
                }
            }

            async Task Reply(byte[] bytes)
            {
                string tool = null;
                try
                {
                    string text = Encoding.UTF8.GetString(bytes);
                    var message = json.DeserializeObject(text) as Dictionary<string, object>;
                    object id;
                    if (message != null && message.TryGetValue("id", out id) && id != null && !message.ContainsKey("method"))
                    {
                        lock (pendingLock)
                        {
                            string key = Key(id);
                            if (pending.TryGetValue(key, out tool)) pending.Remove(key);
                        }
                        if (tool == "get_window_state") Remember(message);
                    }
                }
                catch (Exception)
                {
                    // Not JSON the broker reads; it goes on as it came.
                }
                await writeLock.WaitAsync();
                try
                {
                    await pipe.WriteAsync(bytes, 0, bytes.Length);
                    await pipe.WriteAsync(new byte[] { (byte)'\n' }, 0, 1);
                    await pipe.FlushAsync();
                }
                finally
                {
                    writeLock.Release();
                }
                if (tool != null) RearmIdle();
            }

            /// <summary>The idle time runs only while no request of Kite's is pending.</summary>
            void RearmIdle()
            {
                bool waiting;
                lock (pendingLock) waiting = pending.Count > 0;
                if (!waiting) idle.Change(options.IdleMs, Timeout.Infinite);
            }

            static string Key(object id)
            {
                return (id is string ? "s:" : "n:") + Convert.ToString(id, System.Globalization.CultureInfo.InvariantCulture);
            }

            void Remember(Dictionary<string, object> message)
            {
                var result = message.ContainsKey("result") ? message["result"] as Dictionary<string, object> : null;
                var data = result != null && result.ContainsKey("structuredContent") ? result["structuredContent"] as Dictionary<string, object> : null;
                if (data == null) return;
                string id = data.ContainsKey("snapshot_id") ? data["snapshot_id"] as string : null;
                if (id == null) return;
                var read = new Snapshot { Id = id };
                object value;
                if (data.TryGetValue("window_id", out value)) read.WindowId = Convert.ToInt64(value);
                var bounds = data.ContainsKey("window_bounds") ? data["window_bounds"] as Dictionary<string, object> : null;
                if (bounds != null)
                {
                    read.WindowX = Number(bounds, "x");
                    read.WindowY = Number(bounds, "y");
                    read.WindowWidth = Number(bounds, "width");
                    read.WindowHeight = Number(bounds, "height");
                }
                read.ShotWidth = Number(data, "screenshot_width");
                read.ShotHeight = Number(data, "screenshot_height");
                var elements = data.ContainsKey("elements") ? data["elements"] as System.Collections.IList : null;
                if (elements != null)
                {
                    foreach (object item in elements)
                    {
                        var e = item as Dictionary<string, object>;
                        if (e == null || !e.ContainsKey("element_index")) continue;
                        var element = new Element
                        {
                            Role = e.ContainsKey("role") ? e["role"] as string : null,
                            Label = e.ContainsKey("label") ? e["label"] as string : null,
                        };
                        var frame = e.ContainsKey("frame") ? e["frame"] as Dictionary<string, object> : null;
                        if (frame != null)
                        {
                            element.X = Number(frame, "x");
                            element.Y = Number(frame, "y");
                            element.Width = Number(frame, "w");
                            element.Height = Number(frame, "h");
                            element.HasFrame = element.Width > 0 && element.Height > 0;
                        }
                        read.Elements[Convert.ToInt64(e["element_index"])] = element;
                    }
                }
                lock (snapshots)
                {
                    if (!snapshots.ContainsKey(id)) snapshotOrder.Enqueue(id);
                    snapshots[id] = read;
                    while (snapshotOrder.Count > SnapshotsKept) snapshots.Remove(snapshotOrder.Dequeue());
                    if (read.WindowId > 0) latest[read.WindowId] = read;
                }
            }

            static double Number(Dictionary<string, object> o, string key)
            {
                object value;
                if (!o.TryGetValue(key, out value) || value == null) return 0;
                try { return Convert.ToDouble(value); } catch (Exception) { return 0; }
            }

            static Dictionary<string, object> Arguments(Dictionary<string, object> message)
            {
                var parameters = message["params"] as Dictionary<string, object>;
                return parameters["arguments"] as Dictionary<string, object>;
            }

            /// <summary>Null when the step may go on: harmless, or allowed by the owner in the broker's window.</summary>
            string Confirmed(string name, Dictionary<string, object> arguments)
            {
                Step step;
                lock (snapshots)
                {
                    step = Risk.Assess(name, arguments,
                        id => { Snapshot s; return snapshots.TryGetValue(id, out s) ? s : null; },
                        window => { Snapshot s; return latest.TryGetValue(window, out s) ? s : null; });
                }
                if (step == null) return null;
                // A window whose program does not answer would hold the capture forever; it goes without.
                System.Drawing.Bitmap crop = null;
                var capture = Task.Run(() => Confirm.Crop(step.WindowId, step));
                try
                {
                    if (capture.Wait(2000)) crop = capture.Result;
                }
                catch (Exception)
                {
                    crop = null;
                }
                using (crop)
                {
                    return Confirm.Step(options.TargetImage, step, crop) ? null : "the user did not allow this step";
                }
            }

            /// <summary>Why a request does not pass, or null when it does.</summary>
            string Allowed(string line, out Dictionary<string, object> message, out object id, out bool tool, out string name)
            {
                id = null;
                tool = false;
                name = null;
                message = null;
                try
                {
                    message = json.DeserializeObject(line) as Dictionary<string, object>;
                }
                catch (Exception)
                {
                    return "not JSON";
                }
                if (message == null) return "not a JSON-RPC message";
                message.TryGetValue("id", out id);
                foreach (string key in message.Keys)
                {
                    if (!MessageKeys.Contains(key)) return "the field " + key + " is not available";
                }
                object methodValue;
                string method = message.TryGetValue("method", out methodValue) ? methodValue as string : null;
                if (method == null)
                {
                    // An answer to a request of the driver's, which it never makes of Kite: dropped.
                    id = null;
                    return "no method";
                }
                if (PlainMethods.Contains(method)) return null;
                if (method != "tools/call") return "method " + method + " is not available";
                tool = true;
                object paramsValue;
                var parameters = message.TryGetValue("params", out paramsValue) ? paramsValue as Dictionary<string, object> : null;
                if (parameters == null) return "no params";
                foreach (string key in parameters.Keys)
                {
                    if (!CallKeys.Contains(key)) return "the parameter " + key + " is not available";
                }
                object nameValue;
                name = parameters.TryGetValue("name", out nameValue) ? nameValue as string : null;
                HashSet<string> allowed;
                if (name == null || !Tools.TryGetValue(name, out allowed)) return "the tool " + name + " is not available to the elevated helper";
                object argsValue;
                var arguments = parameters.TryGetValue("arguments", out argsValue) ? argsValue as Dictionary<string, object> : null;
                if (arguments == null) return "no arguments";
                foreach (string key in arguments.Keys)
                {
                    if (!allowed.Contains(key)) return "the argument " + key + " is not available to the elevated helper";
                }
                if (Acting.Contains(name))
                {
                    object mode;
                    if (!arguments.TryGetValue("delivery_mode", out mode) || !"background".Equals(mode))
                        return "the elevated helper acts in the background only";
                }
                try
                {
                    if (name == "list_windows") return SameProcess(arguments, "pid") ? null : OtherProgram();
                    if (name == "get_window_state" || name == "invoke_menu")
                        return SameProcess(arguments, "pid") && OwnWindow(arguments, "window_id") ? null : OtherProgram();
                    object targetValue;
                    var windowTarget = arguments.TryGetValue("target", out targetValue) ? targetValue as Dictionary<string, object> : null;
                    if (windowTarget == null || !"window".Equals(windowTarget.ContainsKey("kind") ? windowTarget["kind"] : null))
                        return "a window target is needed";
                    foreach (string key in windowTarget.Keys)
                    {
                        if (key != "kind" && key != "pid" && key != "window_id") return "the target's " + key + " is not available";
                    }
                    return SameProcess(windowTarget, "pid") && OwnWindow(windowTarget, "window_id") ? null : OtherProgram();
                }
                catch (ArgumentException error)
                {
                    return error.Message;
                }
            }

            string OtherProgram()
            {
                return "the elevated helper acts only on the windows of the program the user approved";
            }

            bool SameProcess(Dictionary<string, object> o, string key)
            {
                return Json.Integer(o, key) == options.Target;
            }

            bool OwnWindow(Dictionary<string, object> o, string key)
            {
                return Native.WindowOwner(Json.Integer(o, key)) == options.Target;
            }

            Dictionary<string, object> Unavailable(object id, string reason)
            {
                return new Dictionary<string, object>
                {
                    { "jsonrpc", "2.0" },
                    { "id", id },
                    { "error", new Dictionary<string, object> { { "code", -32601 }, { "message", "Refused by Kite's elevated helper: " + reason + "." } } },
                };
            }

            Dictionary<string, object> Refused(object id, string reason)
            {
                string text = "Refused by Kite's elevated helper: " + reason + ".";
                return new Dictionary<string, object>
                {
                    { "jsonrpc", "2.0" },
                    { "id", id },
                    { "result", new Dictionary<string, object>
                        {
                            { "content", new object[] { new Dictionary<string, object> { { "type", "text" }, { "text", text } } } },
                            { "structuredContent", new Dictionary<string, object> { { "code", "refused" }, { "message", text } } },
                            { "isError", true },
                        }
                    },
                };
            }

            readonly byte[] readBuffer = new byte[1 << 16];
            int readStart;
            int readEnd;

            /// <summary>The next line from Kite, at most `max` bytes; null when it disconnected.</summary>
            async Task<string> ReadLine(int max)
            {
                var line = new MemoryStream();
                while (true)
                {
                    for (int i = readStart; i < readEnd; i++)
                    {
                        if (readBuffer[i] != '\n') continue;
                        line.Write(readBuffer, readStart, i - readStart);
                        readStart = i + 1;
                        if (line.Length > max) throw new InvalidDataException("A request is too long.");
                        return Encoding.UTF8.GetString(line.GetBuffer(), 0, (int)line.Length).TrimEnd('\r');
                    }
                    line.Write(readBuffer, readStart, readEnd - readStart);
                    readStart = readEnd = 0;
                    if (line.Length > max) throw new InvalidDataException("A request is too long.");
                    int read = await pipe.ReadAsync(readBuffer, 0, readBuffer.Length);
                    if (read <= 0) return null;
                    readEnd = read;
                }
            }

            void Send(object message)
            {
                SendAsync(message).Wait();
            }

            async Task SendAsync(object message)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(message) + "\n");
                await writeLock.WaitAsync();
                try
                {
                    await pipe.WriteAsync(bytes, 0, bytes.Length);
                    await pipe.FlushAsync();
                }
                finally
                {
                    writeLock.Release();
                }
            }

            static string Reason(string what, Task done)
            {
                return done.Exception == null ? what : what + ": " + done.Exception.GetBaseException().Message;
            }

            void End(string reason)
            {
                ended.TrySetResult(reason);
            }

            void Stop()
            {
                if (idle != null) idle.Dispose();
                if (targetJob != IntPtr.Zero)
                {
                    // The program may start programs again once the broker is gone.
                    try { Native.LimitJob(targetJob, 0, 0); } catch (Exception) { }
                    Native.CloseHandle(targetJob);
                }
                if (driver != null)
                {
                    try { if (!driver.HasExited) driver.Kill(); } catch (Exception) { }
                }
                if (driverJob != IntPtr.Zero) Native.CloseHandle(driverJob);
                try { pipe.Dispose(); } catch (Exception) { }
            }
        }
    }
}
