// The elevated broker. It runs as administrator from Program Files\Kite Computer Helper only, for
// one program the owner approves, and serves one connection, then exits:
//
// - It starts through cmd.exe (see Serve.cs and Guard.cs) and refuses to run with a .NET variable
//   that loads code, or a Windows folder other than the system's, in its environment.
// - Who started it is not trusted. Its arguments name the program by process id, start time and
//   image path, which it checks exactly, and it refuses programs that start other programs or run
//   what is typed into them, programs that do not run as administrator and programs that have
//   programs of their own running. The owner then confirms in its own window, which names the
//   program, its window and the process that asks, with that process's command line and parent.
// - Its pipe admits Kite's user alone, by the SID passed in (under Administrator protection the
//   broker runs as the shadow administrator, another account), with a medium label that keeps lower
//   integrity out of reading or writing it. The client must be this same installed helper in its
//   connect mode, started by the Kite program the install recorded (the host process named), and
//   its first line must carry the session's token, whose SHA-256 alone is on the command line. Any
//   process can run Kite's program, so this binds the broker to Kite only loosely; the checks below
//   are the broker's own.
// - While it runs, the program sits in a job that lets it start no process directly; the limit is
//   set before the program joins and lifted when the broker ends.
// - It runs Cua Driver from its own folder, checked against the hash built in while held open, in a
//   job that ends it with the broker and lets it start nothing, with an environment of its own:
//   Windows' folders from the system, home and temporary folders under the install folder and a
//   PATH of System32 alone. It relays only the reading and input tools Kite uses, each scoped to a
//   window of the approved program, with only the arguments Kite sends, each of its type and range,
//   in the background only, one tool call at a time, as it re-serializes them, and asks the owner in
//   its own window before every step but plainly harmless ones (see Risk.cs).
// - It ends when Kite disconnects, the program or Kite's host exits, no request came for the idle
//   time while none was pending, the owner said no to three steps, the driver acted in the
//   foreground, or thirty minutes passed.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
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

        static readonly Regex Plain = new Regex(@"\A[A-Za-z0-9_.:-]+\z");

        static void Add(StringBuilder args, string name, string value)
        {
            args.Append(" --").Append(name).Append(' ');
            // Paths have no quote of their own and never end in a backslash here. Anything but plain
            // words goes in quotes, where cmd.exe, which starts the broker, reads & ( ) ^ as text.
            if (Plain.IsMatch(value)) args.Append(value);
            else args.Append('"').Append(value).Append('"');
        }

        void Validate()
        {
            if (!PipePattern.IsMatch(Pipe)) throw new ArgumentException("pipe must be kite-computer- and 32 hex digits.");
            if (!SidPattern.IsMatch(User)) throw new ArgumentException("user must be an account SID.");
            if (!HashPattern.IsMatch(TokenSha256)) throw new ArgumentException("token-sha256 must be 64 hex digits.");
            if (Host <= 0 || Target <= 0) throw new ArgumentException("host and target must be process ids.");
            if (!Path.IsPathRooted(TargetImage) || TargetImage.IndexOfAny(new[] { '"', '%', '\r', '\n', '\0' }) >= 0 || TargetImage.EndsWith("\\") || TargetImage.Length > 32767)
                throw new ArgumentException("target-image must be a full path.");
            if (Lang != "zh-CN" && Lang != "en") throw new ArgumentException("lang must be zh-CN or en.");
            if (InstallDir != null && (!Build.Test || InstallDir.IndexOfAny(new[] { '"', '%', '\r', '\n', '\0' }) >= 0 || InstallDir.EndsWith("\\")))
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
        /// <summary>
        /// Programs that start other programs or run what is typed into them, which the broker never
        /// drives: what they start or run would run as administrator too. Matched by the image's own
        /// file name.
        /// </summary>
        static readonly HashSet<string> Launchers = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "taskmgr.exe", "cmd.exe", "powershell.exe", "powershell_ise.exe", "pwsh.exe", "windowsterminal.exe",
            "wt.exe", "openconsole.exe", "conhost.exe", "regedit.exe", "regedt32.exe", "mmc.exe", "explorer.exe",
            "rundll32.exe", "mshta.exe", "wscript.exe", "cscript.exe", "msiexec.exe", "control.exe",
            "systeminformer.exe", "processhacker.exe", "procexp.exe", "procexp64.exe", "procexp64a.exe",
            "autoruns.exe", "autoruns64.exe", "autoruns64a.exe", "procmon.exe", "procmon64.exe", "psexec.exe",
            "psexec64.exe", "wsl.exe", "wslhost.exe", "wslg.exe", "bash.exe", "sh.exe", "zsh.exe", "mintty.exe",
            "git-bash.exe", "git-cmd.exe", "python.exe", "pythonw.exe", "py.exe", "pyw.exe", "node.exe",
            "deno.exe", "bun.exe", "perl.exe", "ruby.exe", "rubyw.exe", "php.exe", "java.exe", "javaw.exe",
            "dotnet.exe", "csi.exe", "fsi.exe", "msbuild.exe", "installutil.exe", "regsvr32.exe", "regasm.exe",
            "hh.exe", "schtasks.exe", "taskschd.msc", "services.exe", "sc.exe", "wmic.exe", "runas.exe",
            "conemu.exe", "conemu64.exe", "cmder.exe", "alacritty.exe", "wezterm.exe", "wezterm-gui.exe",
            "tabby.exe", "hyper.exe", "far.exe", "totalcmd.exe", "totalcmd64.exe", "doublecmd.exe",
            "everything.exe", "code.exe", "devenv.exe", "winword.exe", "excel.exe", "powerpnt.exe",
            "msaccess.exe", "outlook.exe", "sqlcmd.exe", "ssms.exe",
        };

        /// <summary>Whether a program by this image path starts other programs or runs code typed into it.</summary>
        public static bool StartsPrograms(string image)
        {
            string name = Path.GetFileName(image ?? "");
            if (Launchers.Contains(name)) return true;
            // python3.exe, python3.12.exe, pythonw3.12.exe and the like.
            return Regex.IsMatch(name, @"\A(python|pythonw|pypy)[0-9.]*\.exe\z", RegexOptions.IgnoreCase);
        }

        public static int Run(Dictionary<string, string> values)
        {
            // A name the launcher did not clear, or another Windows folder, means the runtime may
            // have loaded code already; whatever it is, the broker does nothing more.
            string environment = Guard.BrokerEnvironment() ?? Guard.Registry();
            if (environment != null) return Fail(17, environment);
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
            Record record = Layout.ReadRecord(dir);
            if (record == null || record.Protocol != Layout.Protocol) return Fail(6, "The install has no record of this protocol.");
            if (!Build.Test && !Layout.Protected(dir)) return Fail(18, "Others than administrators may change the install folder.");
            if (Layout.Sha256(own) != record.HelperSha256) return Fail(18, "The broker is not the helper the install recorded.");
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
            // The image as Windows names it, matched exactly: no form of the path that only
            // normalizes to it, such as a trailing dot or space or a short name.
            string image = Native.ImageOf(options.Target);
            if (image == null || !string.Equals(image, options.TargetImage, StringComparison.OrdinalIgnoreCase) || Native.StartedAt(options.Target) != options.TargetStarted)
                return Fail(7, "The process is not the program that was approved.");
            if (StartsPrograms(image)) return Fail(8, "That program starts other programs, which the broker never drives.");
            if (!Build.Test && !Native.IsHigh(options.Target)) return Fail(19, "That program does not run as administrator.");
            // What it started before the broker came would sit outside the job that holds it.
            if (Native.Descendants(options.Target).Count > 0) return Fail(20, "That program has programs of its own running.");
            if (!Layout.SamePath(Native.ImageOf(options.Host), record.Client)) return Fail(7, "The host is not the Kite program the install recorded.");
            if (!Layout.MakeHome(dir)) return Fail(21, "The driver's home folder is a link.");
            Native.SetProcessDPIAware();
            var asker = new Asker
            {
                Image = Native.ImageOf(options.Host),
                Pid = options.Host,
                CommandLine = Native.CommandLine(options.Host),
                ParentImage = ParentImage(options.Host),
            };
            return new Session(options, own, target, host, asker).Run();
        }

        static string ParentImage(int pid)
        {
            int parent = Native.ParentOf(pid);
            if (parent <= 0 || Native.StartedAt(parent) == 0 || Native.StartedAt(parent) > Native.StartedAt(pid)) return null;
            return Native.ImageOf(parent);
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
            /// <summary>However busy, a session ends after this long.</summary>
            const int LifetimeMs = 30 * 60 * 1000;
            /// <summary>A call the driver has not answered in this time ends the session.</summary>
            const int CallWaitMs = 3 * 60 * 1000;
            /// <summary>Steps the owner said no to before the session ends.</summary>
            const int MaxDenied = 3;
            /// <summary>Requests waiting on the driver at once.</summary>
            const int MaxPending = 8;

            static readonly Dictionary<string, HashSet<string>> Tools = new Dictionary<string, HashSet<string>>
            {
                { "list_windows", Set("pid", "on_screen_only") },
                { "get_window_state", Set("pid", "window_id", "query", "since", "max_elements", "max_depth", "include_screenshot", "include_accessibility_tree") },
                { "click", Set("target", "element_token", "x", "y", "button", "count", "delivery_mode") },
                { "type_text", Set("target", "text", "element_token", "delivery_mode") },
                { "press_key", Set("target", "key", "modifiers", "delivery_mode") },
                { "hotkey", Set("target", "keys", "delivery_mode") },
                { "scroll", Set("target", "x", "y", "direction", "amount", "by", "delivery_mode") },
                { "drag", Set("target", "from_x", "from_y", "to_x", "to_y", "button", "modifier", "duration_ms", "steps", "delivery_mode") },
                { "invoke_menu", Set("pid", "window_id", "path", "delivery_mode") },
            };
            static readonly HashSet<string> Acting = Set("click", "type_text", "press_key", "hotkey", "scroll", "drag", "invoke_menu");
            static readonly HashSet<string> MessageKeys = Set("jsonrpc", "id", "method", "params");
            static readonly HashSet<string> CallKeys = Set("name", "arguments", "_meta");
            static readonly Regex TokenPattern = new Regex(@"\A[A-Za-z0-9_-]{1,64}:[0-9]{1,9}\z");

            static HashSet<string> Set(params string[] items)
            {
                return new HashSet<string>(items, StringComparer.Ordinal);
            }

            readonly BrokerOptions options;
            readonly string own;
            readonly Process target;
            readonly Process host;
            readonly Asker asker;
            readonly JavaScriptSerializer json = Json.Create();
            readonly SemaphoreSlim writeLock = new SemaphoreSlim(1, 1);
            readonly TaskCompletionSource<string> ended = new TaskCompletionSource<string>();
            readonly object pendingLock = new object();
            readonly Dictionary<string, string> pending = new Dictionary<string, string>();
            readonly Dictionary<string, Snapshot> snapshots = new Dictionary<string, Snapshot>();
            readonly Queue<string> snapshotOrder = new Queue<string>();
            readonly Dictionary<long, Snapshot> latest = new Dictionary<long, Snapshot>();
            /// <summary>What went through unconfirmed since the owner was last asked.</summary>
            readonly List<string> since = new List<string>();
            /// <summary>Where the last steps left the program: the edit field clicked, a menu open.</summary>
            Focus focus = new Focus();
            int denied;
            /// <summary>Every request id Kite used; a client that uses one again is no client of Kite's.</summary>
            readonly HashSet<string> usedIds = new HashSet<string>(StringComparer.Ordinal);
            const int MaxIds = 100000;
            /// <summary>The tool call the driver has not answered yet, by its key; the next waits for it.</summary>
            string callInFlight;
            TaskCompletionSource<bool> callDone;
            NamedPipeServerStream pipe;
            Process driver;
            IntPtr driverJob = IntPtr.Zero;
            IntPtr targetJob = IntPtr.Zero;
            Timer idle;
            Timer lifetime;

            public Session(BrokerOptions options, string own, Process target, Process host, Asker asker)
            {
                this.options = options;
                this.own = own;
                this.target = target;
                this.host = host;
                this.asker = asker;
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
                    if (!Confirm.Start(options.TargetImage, options.Target, target.MainWindowTitle, asker))
                        return Refuse(14, "the user did not allow it");
                    // The program may have started one in the meantime.
                    if (Native.Descendants(options.Target).Count > 0) return Refuse(20, "the program has programs of its own running");
                    if (!Contain()) return Refuse(15, "the program could not be kept from starting other programs");
                    string failure = StartDriver();
                    if (failure != null) return Refuse(16, failure);
                    Send(new Dictionary<string, object> { { "ok", true }, { "pid", Process.GetCurrentProcess().Id } });
                    WatchExit(target, "the approved program exited");
                    WatchExit(host, "Kite's host exited");
                    WatchExit(driver, "Cua Driver exited");
                    idle = new Timer(delegate { End("idle"); }, null, options.IdleMs, Timeout.Infinite);
                    lifetime = new Timer(delegate { End("its time ran out"); }, null, LifetimeMs, Timeout.Infinite);
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

            /// <summary>
            /// Puts the program in a job that lets it start no process while the broker runs, the
            /// limit set before the program joins, so no start slips in between.
            /// </summary>
            bool Contain()
            {
                targetJob = Native.CreateJobObjectW(IntPtr.Zero, null);
                if (targetJob == IntPtr.Zero) return false;
                try
                {
                    Native.LimitJob(targetJob, Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS, 1);
                    return Native.AssignProcessToJobObject(targetJob, target.Handle);
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
                // Windows' folders as the system names them, never as an environment says, which
                // the user's registry shapes.
                string root = Guard.WindowsDir();
                string system = Guard.SystemDir();
                var env = start.EnvironmentVariables;
                env.Clear();
                env["SystemRoot"] = root;
                env["windir"] = root;
                env["SystemDrive"] = Path.GetPathRoot(root).TrimEnd('\\');
                env["NUMBER_OF_PROCESSORS"] = Environment.ProcessorCount.ToString();
                env["PROCESSOR_ARCHITECTURE"] = Environment.Is64BitOperatingSystem ? "AMD64" : "x86";
                env["ProgramFiles"] = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
                env["ProgramData"] = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                env["USERNAME"] = Environment.UserName;
                // Its own folders under the install folder, which only administrators reach, in
                // place of the user's profile and temporary folder, which the user can write to.
                env["USERPROFILE"] = home;
                env["HOME"] = home;
                env["LOCALAPPDATA"] = Path.Combine(home, "Local");
                env["APPDATA"] = Path.Combine(home, "Roaming");
                env["TEMP"] = Path.Combine(home, "Temp");
                env["TMP"] = Path.Combine(home, "Temp");
                // No ComSpec and no PATH to a shell: it starts no program (its job allows none).
                env["PATH"] = system;
                env["PSModulePath"] = Path.Combine(system, @"WindowsPowerShell\v1.0\Modules");
                env["CUA_DRIVER_EMBEDDED"] = "1";
                env["DO_NOT_TRACK"] = "1";
                env["CUA_DRIVER_RS_UPDATE_CHECK"] = "false";
                env["CUA_DRIVER_DISABLE_UNRESTRICTED"] = "1";
                driverJob = Native.CreateJobObjectW(IntPtr.Zero, null);
                if (driverJob == IntPtr.Zero) return "Cua Driver could not be tied to the broker";
                try
                {
                    // It dies with the broker, and is the job's only process: it starts none.
                    Native.LimitJob(driverJob, Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | Native.JOB_OBJECT_LIMIT_ACTIVE_PROCESS, 1);
                }
                catch (Exception error)
                {
                    return "Cua Driver could not be tied to the broker: " + error.Message;
                }
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
                if (!Native.AssignProcessToJobObject(driverJob, driver.Handle))
                {
                    try { driver.Kill(); } catch (Exception) { }
                    return "Cua Driver could not be tied to the broker";
                }
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

            /// <summary>
            /// Kite's requests: each checked, confirmed when risky, then passed on re-serialized; a
            /// tool call waits until the driver answered the one before, so what the owner is asked
            /// about is never overtaken by an earlier step still running.
            /// </summary>
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
                    if (id != null)
                    {
                        // Kite's client numbers its requests afresh with whole numbers; another kind,
                        // or an id again, would let one answer stand for another request's (5.1 and
                        // 5.10 differ here but may not in the driver's answer), which pending,
                        // ordering and stops rely on.
                        if (!ValidId(id))
                        {
                            End("a request had an id Kite's client never sends");
                            return;
                        }
                        if (!usedIds.Add(Key(id)) || usedIds.Count > MaxIds)
                        {
                            End("a request used an id again");
                            return;
                        }
                    }
                    if (refusal == null && tool)
                    {
                        if (!await CallAnswered()) return;
                        refusal = Confirmed(name, Arguments(message));
                    }
                    if (refusal == null)
                    {
                        lock (pendingLock)
                        {
                            if (id != null && pending.Count >= MaxPending) refusal = "too many requests are waiting";
                            else if (id != null)
                            {
                                pending[Key(id)] = tool ? "tool:" + name : "method";
                                if (tool)
                                {
                                    callInFlight = Key(id);
                                    callDone = new TaskCompletionSource<bool>();
                                }
                            }
                        }
                    }
                    if (refusal != null)
                    {
                        if (id != null) await SendAsync(tool ? Refused(id, refusal) : Unavailable(id, refusal));
                        if (denied >= MaxDenied)
                        {
                            End("the user said no to " + MaxDenied + " steps");
                            return;
                        }
                        RearmIdle();
                        continue;
                    }
                    // What passes is what was checked: the parsed message, written anew, as strict
                    // UTF-8: a lone surrogate, which would read as U+FFFD to the driver though it
                    // differs here, fails and ends the session. The JSON reader replaces them already.
                    byte[] bytes = Strict.GetBytes(json.Serialize(message) + "\n");
                    await input.WriteAsync(bytes, 0, bytes.Length);
                    await input.FlushAsync();
                    RearmIdle();
                }
            }

            /// <summary>Waits for the driver's answer to the call before; false when it never came.</summary>
            async Task<bool> CallAnswered()
            {
                Task<bool> waiting;
                lock (pendingLock) waiting = callInFlight == null ? null : callDone.Task;
                if (waiting == null) return true;
                if (await Task.WhenAny(waiting, Task.Delay(CallWaitMs)) == waiting) return true;
                End("Cua Driver did not answer a call");
                return false;
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
                bool foreground = false;
                try
                {
                    string text = Encoding.UTF8.GetString(bytes);
                    var message = json.DeserializeObject(text) as Dictionary<string, object>;
                    object id;
                    if (message != null && message.TryGetValue("id", out id) && id != null && !message.ContainsKey("method"))
                    {
                        string key = Key(id);
                        lock (pendingLock)
                        {
                            string what;
                            if (pending.TryGetValue(key, out what))
                            {
                                pending.Remove(key);
                                // The call in flight is released by its own answer alone: same id, a tool call.
                                if (what.StartsWith("tool:", StringComparison.Ordinal))
                                {
                                    tool = what.Substring(5);
                                    if (key == callInFlight)
                                    {
                                        callInFlight = null;
                                        callDone.TrySetResult(true);
                                    }
                                }
                                else
                                {
                                    tool = "";
                                }
                            }
                        }
                        if (tool == "get_window_state") Remember(message);
                        else if (tool != null && Acting.Contains(tool)) foreground = InForeground(message);
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
                // Input that went to the front reached whatever had the focus there: the session ends.
                if (foreground) End("Cua Driver acted in the foreground");
                if (tool != null) RearmIdle();
            }

            static bool InForeground(Dictionary<string, object> message)
            {
                var result = message.ContainsKey("result") ? message["result"] as Dictionary<string, object> : null;
                var data = result != null && result.ContainsKey("structuredContent") ? result["structuredContent"] as Dictionary<string, object> : null;
                var delivery = data != null && data.ContainsKey("delivery") ? data["delivery"] as Dictionary<string, object> : null;
                return delivery != null && "foreground".Equals(delivery.ContainsKey("mode") ? delivery["mode"] : null);
            }

            /// <summary>The idle time runs only while no request of Kite's is pending.</summary>
            void RearmIdle()
            {
                bool waiting;
                lock (pendingLock) waiting = pending.Count > 0;
                if (!waiting) idle.Change(options.IdleMs, Timeout.Infinite);
            }

            const long MaxWholeId = 9007199254740992;

            static readonly UTF8Encoding Strict = new UTF8Encoding(false, true);
            static readonly Regex PrintableId = new Regex(@"\A[\x20-\x7E]{1,128}\z");

            /// <summary>
            /// A whole number within what a JSON reader keeps exactly, or a short string of printable
            /// ASCII, which reads the same on both sides of every encoding.
            /// </summary>
            static bool ValidId(object id)
            {
                long number;
                return id is string ? PrintableId.IsMatch((string)id) : WholeId(id, out number);
            }

            static bool WholeId(object id, out long number)
            {
                number = 0;
                if (id is int) number = (int)id;
                else if (id is long) number = (long)id;
                else if (id is decimal)
                {
                    decimal value = (decimal)id;
                    if (decimal.Truncate(value) != value || value > MaxWholeId || value < -MaxWholeId) return false;
                    number = (long)value;
                }
                else return false;
                return number <= MaxWholeId && number >= -MaxWholeId;
            }

            static string Key(object id)
            {
                if (id is string) return "s:" + (string)id;
                long number;
                return WholeId(id, out number) ? "n:" + number.ToString(CultureInfo.InvariantCulture) : "x:" + Convert.ToString(id, CultureInfo.InvariantCulture);
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
                if (data.TryGetValue("window_id", out value)) read.WindowId = Convert.ToInt64(value, CultureInfo.InvariantCulture);
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
                        read.Elements[Convert.ToInt64(e["element_index"], CultureInfo.InvariantCulture)] = element;
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
                try { return Convert.ToDouble(value, CultureInfo.InvariantCulture); } catch (Exception) { return 0; }
            }

            /// <summary>The window a call's arguments name, by window_id or its target's.</summary>
            static long WindowOf(Dictionary<string, object> arguments)
            {
                object value;
                if (arguments.TryGetValue("window_id", out value) && (value is int || value is long)) return Convert.ToInt64(value, CultureInfo.InvariantCulture);
                var target = arguments.ContainsKey("target") ? arguments["target"] as Dictionary<string, object> : null;
                if (target != null && target.TryGetValue("window_id", out value) && (value is int || value is long)) return Convert.ToInt64(value, CultureInfo.InvariantCulture);
                return 0;
            }

            static Dictionary<string, object> Arguments(Dictionary<string, object> message)
            {
                var parameters = message["params"] as Dictionary<string, object>;
                return parameters["arguments"] as Dictionary<string, object>;
            }

            /// <summary>
            /// Null when the step may go on: harmless, or allowed by the owner in the broker's
            /// window; else why not. A harmless step goes on the list the next question shows.
            /// </summary>
            string Confirmed(string name, Dictionary<string, object> arguments)
            {
                Assessment assessment;
                // What the program's own thread says beats what the steps so far suggest: a menu
                // it shows is open whichever way it was opened.
                Focus now = focus;
                if (!now.MenuOpen && Native.InMenuMode(WindowOf(arguments)))
                    now = new Focus { Edit = focus.Edit, EditToken = focus.EditToken, MenuOpen = true };
                lock (snapshots)
                {
                    assessment = Risk.Assess(name, arguments,
                        id => { Snapshot s; return snapshots.TryGetValue(id, out s) ? s : null; },
                        window => { Snapshot s; return latest.TryGetValue(window, out s) ? s : null; },
                        now);
                }
                Step step = assessment.Step;
                if (step == null)
                {
                    if (Acting.Contains(name))
                    {
                        focus = assessment.Next;
                        if (assessment.Done != null) since.Add(assessment.Done);
                    }
                    return null;
                }
                if (step.Refusal != null) return step.Refusal;
                // A window that shows files (an Open or Save dialog, a folder view) turns a drag into
                // a move or copy of files as administrator, which the picture cannot show.
                bool files = Native.HostsShellView(step.WindowId);
                if (files && step.Kind == "drag")
                    return "a drag in a window that shows files can move or copy files as administrator, so the elevated helper never drags there";
                focus = new Focus { MenuOpen = step.OpensMenu };
                // A window whose program does not answer would hold the capture forever; it goes without.
                System.Drawing.Bitmap picture = null;
                var capture = Task.Run(() => Confirm.Picture(step.WindowId, step));
                try
                {
                    if (capture.Wait(2000)) picture = capture.Result;
                }
                catch (Exception)
                {
                    picture = null;
                }
                bool allowed;
                using (picture)
                {
                    allowed = Confirm.Step(options.TargetImage, step, picture, since, files);
                }
                since.Clear();
                if (allowed) return null;
                focus = new Focus();
                denied++;
                return "the user did not allow this step";
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
                if (id != null && !(id is string || id is int || id is long || id is decimal)) return "the id is not a string or a number";
                foreach (string key in message.Keys)
                {
                    if (!MessageKeys.Contains(key)) return "the field " + key + " is not available";
                }
                if (!"2.0".Equals(message.ContainsKey("jsonrpc") ? message["jsonrpc"] : null)) return "not JSON-RPC 2.0";
                object methodValue;
                string method = message.TryGetValue("method", out methodValue) ? methodValue as string : null;
                if (method == null)
                {
                    // An answer to a request of the driver's, which it never makes of Kite: dropped.
                    id = null;
                    return "no method";
                }
                object paramsValue;
                bool hasParams = message.TryGetValue("params", out paramsValue);
                var parameters = paramsValue as Dictionary<string, object>;
                if (hasParams && parameters == null) return "params must be an object";
                if (method != "tools/call")
                {
                    string plain = PlainParams(method, parameters);
                    return plain;
                }
                tool = true;
                if (id == null) return "a tool call needs an id";
                if (parameters == null) return "no params";
                foreach (string key in parameters.Keys)
                {
                    if (!CallKeys.Contains(key)) return "the parameter " + key + " is not available";
                }
                string meta = Meta(parameters);
                if (meta != null) return meta;
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
                    string typed = Typed(name, arguments);
                    if (typed != null) return typed;
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

            /// <summary>What a message other than a tool call may carry: what Kite's MCP client sends, no more.</summary>
            static string PlainParams(string method, Dictionary<string, object> parameters)
            {
                switch (method)
                {
                    case "initialize":
                    {
                        if (parameters == null) return "initialize needs params";
                        foreach (string key in parameters.Keys)
                        {
                            if (key != "protocolVersion" && key != "clientInfo" && key != "capabilities") return "initialize's " + key + " is not available";
                        }
                        if (!(parameters.ContainsKey("protocolVersion") && parameters["protocolVersion"] is string)) return "initialize needs a protocolVersion";
                        var capabilities = parameters.ContainsKey("capabilities") ? parameters["capabilities"] as Dictionary<string, object> : null;
                        if (capabilities == null || capabilities.Count > 0) return "initialize asks for no capabilities here";
                        var client = parameters.ContainsKey("clientInfo") ? parameters["clientInfo"] as Dictionary<string, object> : null;
                        if (client == null) return "initialize needs clientInfo";
                        foreach (KeyValuePair<string, object> field in client)
                        {
                            if ((field.Key != "name" && field.Key != "version" && field.Key != "title") || !(field.Value is string) || ((string)field.Value).Length > 200)
                                return "clientInfo's " + field.Key + " is not available";
                        }
                        return null;
                    }
                    case "notifications/initialized":
                    case "ping":
                        return Only(method, parameters);
                    case "tools/list":
                    {
                        if (parameters == null) return null;
                        foreach (string key in parameters.Keys)
                        {
                            if (key != "cursor" && key != "_meta") return "tools/list's " + key + " is not available";
                        }
                        if (parameters.ContainsKey("cursor") && !(parameters["cursor"] is string)) return "the cursor must be text";
                        return Meta(parameters);
                    }
                    case "notifications/cancelled":
                    {
                        if (parameters == null) return "a cancellation needs params";
                        foreach (KeyValuePair<string, object> field in parameters)
                        {
                            if (field.Key == "requestId" && (field.Value is string || field.Value is int || field.Value is long)) continue;
                            if (field.Key == "reason" && field.Value is string && ((string)field.Value).Length <= 1000) continue;
                            return "a cancellation's " + field.Key + " is not available";
                        }
                        return null;
                    }
                    default:
                        return "method " + method + " is not available";
                }
            }

            static string Only(string method, Dictionary<string, object> parameters)
            {
                if (parameters == null) return null;
                foreach (string key in parameters.Keys)
                {
                    if (key != "_meta") return method + "'s " + key + " is not available";
                }
                return Meta(parameters);
            }

            /// <summary>`_meta` may carry a progress token alone.</summary>
            static string Meta(Dictionary<string, object> parameters)
            {
                if (!parameters.ContainsKey("_meta")) return null;
                var meta = parameters["_meta"] as Dictionary<string, object>;
                if (meta == null) return "_meta must be an object";
                foreach (KeyValuePair<string, object> field in meta)
                {
                    if (field.Key != "progressToken" || !(field.Value is string || field.Value is int || field.Value is long)) return "_meta's " + field.Key + " is not available";
                }
                return null;
            }

            /// <summary>Each argument's type, choice and range, as Kite sends them; null when they fit.</summary>
            static string Typed(string name, Dictionary<string, object> a)
            {
                switch (name)
                {
                    case "list_windows":
                        return Whole(a, "pid", 1, int.MaxValue, true) ?? Flag(a, "on_screen_only");
                    case "get_window_state":
                        return Whole(a, "pid", 1, int.MaxValue, true) ?? Whole(a, "window_id", 0, long.MaxValue, true) ??
                            Words(a, "query", 200) ?? Words(a, "since", 64) ?? Whole(a, "max_elements", 1, 2000, false) ??
                            Whole(a, "max_depth", 1, 100, false) ?? Flag(a, "include_screenshot") ??
                            Flag(a, "include_accessibility_tree");
                    case "click":
                    {
                        bool token = a.ContainsKey("element_token");
                        bool point = a.ContainsKey("x") || a.ContainsKey("y");
                        // One or the other: a driver that preferred the point would click where no one looked.
                        if (token == point) return "a click takes an element_token or x and y, not both";
                        if (token && !(a["element_token"] is string && TokenPattern.IsMatch((string)a["element_token"]))) return "element_token is not a token";
                        if (point && (Coordinate(a, "x", true) ?? Coordinate(a, "y", true)) != null) return "x and y must be numbers";
                        return Choice(a, "button", "left", "right", "middle") ?? Whole(a, "count", 1, 3, false);
                    }
                    case "type_text":
                    {
                        if (a.ContainsKey("element_token") && !(a["element_token"] is string && TokenPattern.IsMatch((string)a["element_token"]))) return "element_token is not a token";
                        object text;
                        if (!a.TryGetValue("text", out text) || !(text is string) || ((string)text).Length == 0) return "text must be text";
                        // A control character is a key of its own to a field: U+0016 pastes, U+0003
                        // copies. Line breaks and tabs are the Enter and Tab keys, asked and shown.
                        foreach (char c in (string)text)
                        {
                            if ((c < 0x20 && c != '\t' && c != '\n' && c != '\r') || (c >= 0x7f && c <= 0x9f))
                                return "the text holds a control character, which a field takes as a command, such as paste";
                        }
                        return null;
                    }
                    case "press_key":
                    {
                        object key;
                        if (!a.TryGetValue("key", out key) || !(key is string) || !Risk.KnownKey((string)key)) return "the key is not one the elevated helper presses";
                        return Modifiers(a, "modifiers");
                    }
                    case "hotkey":
                    {
                        object value;
                        var keys = a.TryGetValue("keys", out value) ? value as System.Collections.IList : null;
                        if (keys == null || keys.Count < 2 || keys.Count > 6) return "keys must list 2 to 6 keys";
                        foreach (object k in keys)
                        {
                            if (!(k is string) || !Risk.KnownKey((string)k)) return "a key is not one the elevated helper presses";
                        }
                        return null;
                    }
                    case "scroll":
                        return Coordinate(a, "x", true) ?? Coordinate(a, "y", true) ?? Choice(a, "direction", "up", "down", "left", "right") ??
                            (a.ContainsKey("direction") ? null : "direction is needed") ?? Whole(a, "amount", 1, 50, false) ?? Choice(a, "by", "line", "page");
                    case "drag":
                        return Coordinate(a, "from_x", true) ?? Coordinate(a, "from_y", true) ?? Coordinate(a, "to_x", true) ?? Coordinate(a, "to_y", true) ??
                            Choice(a, "button", "left", "right", "middle") ?? Modifiers(a, "modifier") ?? Whole(a, "duration_ms", 0, 10000, false) ??
                            Whole(a, "steps", 1, 200, false);
                    case "invoke_menu":
                    {
                        object value;
                        var path = a.TryGetValue("path", out value) ? value as System.Collections.IList : null;
                        if (path == null || path.Count < 1 || path.Count > 10) return "path must list 1 to 10 menu items";
                        foreach (object item in path)
                        {
                            if (!(item is string) || ((string)item).Length == 0 || ((string)item).Length > 200) return "a menu item is not a name";
                        }
                        return null;
                    }
                    default:
                        return "the tool " + name + " is not available to the elevated helper";
                }
            }

            static string Whole(Dictionary<string, object> a, string key, long min, long max, bool required)
            {
                object value;
                if (!a.TryGetValue(key, out value)) return required ? key + " is needed" : null;
                long number;
                try { number = Json.Integer(value, key); } catch (ArgumentException) { return key + " must be a whole number"; }
                return number < min || number > max ? key + " is out of range" : null;
            }

            static string Coordinate(Dictionary<string, object> a, string key, bool required)
            {
                object value;
                if (!a.TryGetValue(key, out value)) return required ? key + " is needed" : null;
                if (!(value is int || value is long || value is decimal)) return key + " must be a number";
                double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                return number < -100000 || number > 100000 ? key + " is out of range" : null;
            }

            static string Flag(Dictionary<string, object> a, string key)
            {
                return !a.ContainsKey(key) || a[key] is bool ? null : key + " must be true or false";
            }

            static string Words(Dictionary<string, object> a, string key, int max)
            {
                return !a.ContainsKey(key) || (a[key] is string && ((string)a[key]).Length <= max) ? null : key + " must be text of at most " + max + " characters";
            }

            static string Choice(Dictionary<string, object> a, string key, params string[] choices)
            {
                if (!a.ContainsKey(key)) return null;
                return a[key] is string && Array.IndexOf(choices, (string)a[key]) >= 0 ? null : key + " must be one of " + string.Join(", ", choices);
            }

            static string Modifiers(Dictionary<string, object> a, string key)
            {
                if (!a.ContainsKey(key)) return null;
                var list = a[key] as System.Collections.IList;
                if (list == null || list.Count > 4) return key + " must list up to 4 modifiers";
                foreach (object item in list)
                {
                    if (!(item is string) || !Risk.ModifierNames.Contains((string)item)) return key + " may hold cmd, ctrl, alt and shift";
                }
                return null;
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
                if (lifetime != null) lifetime.Dispose();
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
