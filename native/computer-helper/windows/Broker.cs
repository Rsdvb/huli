// The elevated broker. The owner starts it through the administrator prompt, for one program he
// approved; it then serves Kite's agent host alone and only that program's windows:
//
// - Its named pipe's DACL names one account, Kite's user, by the SID Kite passed (under Windows 11
//   Administrator protection the broker runs as the shadow administrator, a different account), and
//   its medium mandatory label lets Kite, which runs at medium integrity, write to it while low
//   integrity processes cannot. Remote clients are refused, and the first instance claims the name.
// - The client must be the process Kite named, running as that account, and its first line must
//   carry the session's token, whose SHA-256 alone is on the command line. Three refusals end it.
// - It runs Cua Driver, from its own folder, as its child and relays only the reading and input
//   tools Kite uses, each scoped to a window of the approved process, with only the arguments Kite
//   sends, and in the background only. No tool that launches, kills, scripts, reads the clipboard
//   or writes files passes.
// - It exits when Kite disconnects, the approved program or Kite's host exits, or no request came
//   for the idle time, and Cua Driver goes with it.

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
        static readonly Regex PipePattern = new Regex("^kite-computer-[0-9a-f]{32}$");
        static readonly Regex SidPattern = new Regex("^S-1-(5-21|12-1)(-[0-9]{1,10}){1,14}$");
        static readonly Regex HashPattern = new Regex("^[0-9a-f]{64}$");
        public const int DefaultIdleMs = 10 * 60 * 1000;

        public string Pipe;
        public string User;
        public int Client;
        public int Target;
        public string TokenSha256;
        public int IdleMs = DefaultIdleMs;

        public static BrokerOptions FromArgs(string[] args)
        {
            var values = new Dictionary<string, string>();
            for (int i = 1; i < args.Length; i += 2)
            {
                if (i + 1 >= args.Length || !args[i].StartsWith("--")) throw new ArgumentException("Bad option " + args[i] + ".");
                values[args[i].Substring(2)] = args[i + 1];
            }
            var o = new BrokerOptions();
            o.Pipe = Need(values, "pipe");
            o.User = Need(values, "user");
            o.Client = ParsePid(Need(values, "client"), "client");
            o.Target = ParsePid(Need(values, "target"), "target");
            o.TokenSha256 = Need(values, "token-sha256");
            string idle;
            if (values.TryGetValue("idle", out idle)) o.IdleMs = ParseIdle(idle);
            o.Validate();
            return o;
        }

        public static BrokerOptions FromRequest(Dictionary<string, object> request)
        {
            var o = new BrokerOptions();
            o.Pipe = Json.Text(request, "pipe");
            o.User = Json.Text(request, "user");
            o.Client = (int)Math.Min(int.MaxValue, Json.Integer(request, "client"));
            o.Target = (int)Math.Min(int.MaxValue, Json.Integer(request, "target"));
            o.TokenSha256 = Json.Text(request, "tokenSha256");
            object idle;
            if (request.TryGetValue("idleMs", out idle) && idle != null) o.IdleMs = ParseIdle(Json.Integer(idle, "idleMs").ToString());
            o.Validate();
            return o;
        }

        public string ToArguments()
        {
            return "broker --pipe " + Pipe + " --user " + User + " --client " + Client + " --target " + Target +
                " --token-sha256 " + TokenSha256 + " --idle " + IdleMs;
        }

        void Validate()
        {
            if (!PipePattern.IsMatch(Pipe)) throw new ArgumentException("pipe must be kite-computer- and 32 hex digits.");
            if (!SidPattern.IsMatch(User)) throw new ArgumentException("user must be an account SID.");
            if (!HashPattern.IsMatch(TokenSha256)) throw new ArgumentException("token-sha256 must be 64 hex digits.");
            if (Client <= 0 || Target <= 0) throw new ArgumentException("client and target must be process ids.");
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
        const int ConnectWaitMs = 60000;
        const int HelloWaitMs = 10000;
        const int MaxHello = 4096;
        const int MaxRequest = 1024 * 1024;
        const int MaxRefusals = 3;
        const uint FILE_FLAG_OVERLAPPED = 0x40000000;

        /// <summary>The tools that pass, each with the only arguments it may carry.</summary>
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

        static readonly HashSet<string> PlainMethods = Set("initialize", "notifications/initialized", "notifications/cancelled", "ping", "tools/list");

        /// <summary>What Cua Driver gets of the broker's environment, beside its own switches.</summary>
        static readonly string[] Passed = { "SystemRoot", "SystemDrive", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "USERNAME", "PROCESSOR_ARCHITECTURE", "ProgramFiles", "ProgramData", "ComSpec", "NUMBER_OF_PROCESSORS" };

        static HashSet<string> Set(params string[] items)
        {
            return new HashSet<string>(items, StringComparer.Ordinal);
        }

        public static int Run(string[] args)
        {
            BrokerOptions options;
            try
            {
                options = BrokerOptions.FromArgs(args);
            }
            catch (ArgumentException error)
            {
                Console.Error.WriteLine(error.Message);
                return 2;
            }
            string driver = Path.Combine(Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName), "cua-driver.exe");
            if (!File.Exists(driver))
            {
                Console.Error.WriteLine("No cua-driver.exe beside the helper.");
                return 6;
            }
            Process target, client;
            try
            {
                target = Process.GetProcessById(options.Target);
                client = Process.GetProcessById(options.Client);
                // Holding the handles keeps both ids from going to another process.
                var unused = target.Handle;
                unused = client.Handle;
            }
            catch (Exception)
            {
                Console.Error.WriteLine("The approved program or Kite is not running.");
                return 7;
            }
            return new Session(options, driver, target, client).Run();
        }

        sealed class Session
        {
            readonly BrokerOptions options;
            readonly string driverPath;
            readonly Process target;
            readonly Process client;
            readonly JavaScriptSerializer json = Json.Create();
            readonly SemaphoreSlim writeLock = new SemaphoreSlim(1, 1);
            readonly TaskCompletionSource<string> ended = new TaskCompletionSource<string>();
            NamedPipeServerStream pipe;
            Process driver;
            Timer idle;

            public Session(BrokerOptions options, string driverPath, Process target, Process client)
            {
                this.options = options;
                this.driverPath = driverPath;
                this.target = target;
                this.client = client;
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
                    StartDriver();
                    WatchExit(target, "the approved program exited");
                    WatchExit(client, "Kite's host exited");
                    idle = new Timer(delegate { End("idle"); }, null, options.IdleMs, Timeout.Infinite);
                    Task requests = Requests();
                    Task replies = Replies();
                    requests.ContinueWith(delegate { End("Kite disconnected"); });
                    replies.ContinueWith(delegate { End("Cua Driver exited"); });
                    ended.Task.Wait();
                    return 0;
                }
                finally
                {
                    Stop();
                }
            }

            SafePipeHandle CreatePipe()
            {
                string sddl = "D:P(A;;GRGW;;;" + options.User + ")S:(ML;;NW;;;ME)";
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
                        Native.PIPE_ACCESS_DUPLEX | Native.FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
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
                    string refusal = Check();
                    if (refusal == null)
                    {
                        Send(new Dictionary<string, object> { { "ok", true }, { "pid", Process.GetCurrentProcess().Id } });
                        return 0;
                    }
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
                    readStart = readEnd = 0;
                    refusals++;
                }
                return 5;
            }

            /// <summary>Why the connected client is refused, or null when it is Kite.</summary>
            string Check()
            {
                int pid;
                if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle, out pid) || pid != options.Client)
                    return "not the expected process";
                string user = Native.ProcessUser(pid);
                if (user == null || !string.Equals(user, options.User, StringComparison.OrdinalIgnoreCase))
                    return "not the expected account";
                string line;
                try
                {
                    var read = ReadLine(MaxHello);
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

            void StartDriver()
            {
                var start = new ProcessStartInfo(driverPath, "mcp --direct")
                {
                    UseShellExecute = false,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(driverPath),
                };
                var mine = Environment.GetEnvironmentVariables();
                start.EnvironmentVariables.Clear();
                foreach (string name in Passed)
                {
                    object value = mine[name];
                    if (value != null) start.EnvironmentVariables[name] = (string)value;
                }
                string root = Environment.GetEnvironmentVariable("SystemRoot") ?? @"C:\Windows";
                // System folders only: the elevated driver resolves nothing from the user's own PATH.
                start.EnvironmentVariables["PATH"] = root + @"\System32;" + root + ";" + root + @"\System32\WindowsPowerShell\v1.0";
                start.EnvironmentVariables["CUA_DRIVER_EMBEDDED"] = "1";
                start.EnvironmentVariables["DO_NOT_TRACK"] = "1";
                start.EnvironmentVariables["CUA_DRIVER_RS_UPDATE_CHECK"] = "false";
                start.EnvironmentVariables["CUA_DRIVER_DISABLE_UNRESTRICTED"] = "1";
                driver = Process.Start(start);
                // Its stderr is read and dropped so a full pipe never blocks it.
                var stderr = driver.StandardError.BaseStream;
                Task.Factory.StartNew(delegate
                {
                    var sink = new byte[4096];
                    try { while (stderr.Read(sink, 0, sink.Length) > 0) { } } catch (Exception) { }
                }, TaskCreationOptions.LongRunning);
            }

            void WatchExit(Process process, string reason)
            {
                Task.Factory.StartNew(delegate
                {
                    try { process.WaitForExit(); } catch (Exception) { }
                    End(reason);
                }, TaskCreationOptions.LongRunning);
            }

            /// <summary>Kite's requests: each one checked, then passed to Cua Driver or refused.</summary>
            async Task Requests()
            {
                Stream input = driver.StandardInput.BaseStream;
                while (true)
                {
                    string line = await ReadLine(MaxRequest);
                    if (line == null) return;
                    if (line.Trim().Length == 0) continue;
                    idle.Change(options.IdleMs, Timeout.Infinite);
                    object id;
                    bool tool;
                    string refusal = Allowed(line, out id, out tool);
                    if (refusal == null)
                    {
                        byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
                        await input.WriteAsync(bytes, 0, bytes.Length);
                        await input.FlushAsync();
                    }
                    else if (id != null)
                    {
                        await SendAsync(tool ? Refused(id, refusal) : Unavailable(id, refusal));
                    }
                }
            }

            /// <summary>Cua Driver's answers, passed to Kite as they come.</summary>
            async Task Replies()
            {
                Stream output = driver.StandardOutput.BaseStream;
                var buffer = new byte[1 << 16];
                while (true)
                {
                    int read = await output.ReadAsync(buffer, 0, buffer.Length);
                    if (read <= 0) return;
                    await writeLock.WaitAsync();
                    try
                    {
                        await pipe.WriteAsync(buffer, 0, read);
                        await pipe.FlushAsync();
                    }
                    finally
                    {
                        writeLock.Release();
                    }
                }
            }

            /// <summary>Why a request does not pass, or null when it does; `id` is its JSON-RPC id.</summary>
            string Allowed(string line, out object id, out bool tool)
            {
                id = null;
                tool = false;
                Dictionary<string, object> message;
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
                object nameValue;
                string name = parameters.TryGetValue("name", out nameValue) ? nameValue as string : null;
                HashSet<string> allowed;
                if (name == null || !Tools.TryGetValue(name, out allowed)) return "the tool " + name + " is not available to the elevated helper";
                object argsValue;
                var arguments = parameters.TryGetValue("arguments", out argsValue) ? argsValue as Dictionary<string, object> : null;
                if (arguments == null) return "no arguments";
                foreach (string key in arguments.Keys)
                {
                    if (!allowed.Contains(key)) return "the argument " + key + " is not available to the elevated helper";
                }
                object mode;
                if (arguments.TryGetValue("delivery_mode", out mode) && !"background".Equals(mode))
                    return "the elevated helper acts in the background only";
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
                long window = Json.Integer(o, key);
                return Native.WindowOwner(window) == options.Target;
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

            void End(string reason)
            {
                ended.TrySetResult(reason);
            }

            void Stop()
            {
                if (idle != null) idle.Dispose();
                if (driver != null)
                {
                    try { if (!driver.HasExited) driver.Kill(); } catch (Exception) { }
                }
                try { pipe.Dispose(); } catch (Exception) { }
            }
        }
    }
}
