// Kite's end of the broker's pipe: `connect --pipe NAME --server PID`, started by Kite's agent host
// from the install folder, without elevation. Kite cannot ask Windows who serves a pipe, so this does
// before the session's token goes over it: the server must be the process Kite's prompt started,
// running the same installed helper, as administrator. It reads the token as the first line of its
// stdin, hands it to the broker, writes the broker's answer as the first line of its stdout, then
// relays both ways until either side closes.

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Kite.ComputerHelper
{
    static class Connect
    {
        static readonly Regex PipePattern = new Regex(@"\Akite-computer-[0-9a-f]{32}\z");
        const int ConnectWaitMs = 20000;
        // The broker answers once the owner answered its window, which waits up to two minutes.
        const int AnswerWaitMs = 150000;

        public static int Run(Dictionary<string, string> options)
        {
            string name, serverText, other;
            int server;
            if (!options.TryGetValue("pipe", out name) || !PipePattern.IsMatch(name)) return Fail(2, "--pipe must be kite-computer- and 32 hex digits.");
            if (!options.TryGetValue("server", out serverText) || !int.TryParse(serverText, out server) || server <= 0) return Fail(2, "--server must be a process id.");
            options.TryGetValue("install-dir", out other);
            string own = Layout.OwnPath();
            if (!Layout.SamePath(Path.GetDirectoryName(own), Layout.InstallDir(other))) return Fail(13, "connect runs only from the install folder.");

            Stream stdin = Console.OpenStandardInput();
            Stream stdout = Console.OpenStandardOutput();
            string hello = ReadLine(stdin, 4096);
            if (hello == null) return Fail(2, "No token came.");

            var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
            var deadline = DateTime.UtcNow.AddMilliseconds(ConnectWaitMs);
            while (true)
            {
                try
                {
                    pipe.Connect(500);
                    break;
                }
                catch (Exception)
                {
                    if (DateTime.UtcNow > deadline) return Answer(stdout, "the elevated helper could not be reached");
                }
            }
            int actual;
            if (!Native.GetNamedPipeServerProcessId(pipe.SafePipeHandle, out actual) || actual != server)
                return Answer(stdout, "the pipe is not served by the helper Kite started");
            if (!Layout.SamePath(Native.ImageOf(actual), own))
                return Answer(stdout, "the pipe is not served by the installed helper");
            if (!Build.Test && !Native.IsHigh(actual))
                return Answer(stdout, "the pipe's server does not run as administrator");

            byte[] token = Encoding.UTF8.GetBytes(hello + "\n");
            pipe.Write(token, 0, token.Length);
            pipe.Flush();

            // The broker's answer is its first line; what follows it is the session's.
            var buffer = new byte[1 << 16];
            var answer = new MemoryStream();
            byte[] rest = null;
            var reading = Task.Run(() =>
            {
                while (true)
                {
                    int read = pipe.Read(buffer, 0, buffer.Length);
                    if (read <= 0) return false;
                    int end = Array.IndexOf(buffer, (byte)'\n', 0, read);
                    if (end < 0)
                    {
                        answer.Write(buffer, 0, read);
                        if (answer.Length > 4096) return false;
                        continue;
                    }
                    answer.Write(buffer, 0, end + 1);
                    if (read > end + 1)
                    {
                        rest = new byte[read - end - 1];
                        Array.Copy(buffer, end + 1, rest, 0, rest.Length);
                    }
                    return true;
                }
            });
            if (!reading.Wait(AnswerWaitMs) || !reading.Result) return Answer(stdout, "the elevated helper did not answer");
            byte[] first = answer.ToArray();
            stdout.Write(first, 0, first.Length);
            stdout.Flush();
            var parsed = Json.Create().DeserializeObject(Encoding.UTF8.GetString(first)) as Dictionary<string, object>;
            object ok;
            if (parsed == null || !parsed.TryGetValue("ok", out ok) || !true.Equals(ok)) return 1;
            if (rest != null)
            {
                stdout.Write(rest, 0, rest.Length);
                stdout.Flush();
            }

            var up = stdin.CopyToAsync(pipe).ContinueWith(_ => { });
            var down = pipe.CopyToAsync(stdout).ContinueWith(_ => { });
            Task.WaitAny(up, down);
            try { pipe.Dispose(); } catch (Exception) { }
            return 0;
        }

        static int Answer(Stream stdout, string error)
        {
            byte[] bytes = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"" + error + "\"}\n");
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
            return 1;
        }

        static string ReadLine(Stream stream, int max)
        {
            var bytes = new MemoryStream();
            while (bytes.Length < max)
            {
                int b = stream.ReadByte();
                if (b < 0) return null;
                if (b == '\n') return Encoding.UTF8.GetString(bytes.ToArray()).TrimEnd('\r');
                bytes.WriteByte((byte)b);
            }
            return null;
        }

        static int Fail(int code, string message)
        {
            Console.Error.WriteLine(message);
            return code;
        }
    }
}
