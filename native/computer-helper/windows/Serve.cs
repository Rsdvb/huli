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

        /// <summary>
        /// Starts this program as the broker through the administrator prompt, which the owner
        /// answers on the secure desktop. Cancelled when they say no.
        /// </summary>
        static object Elevate(Dictionary<string, object> request)
        {
            var options = BrokerOptions.FromRequest(request);
            var start = new ProcessStartInfo
            {
                FileName = Process.GetCurrentProcess().MainModule.FileName,
                Arguments = options.ToArguments(),
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            try
            {
                using (var process = Process.Start(start))
                {
                    return new Dictionary<string, object> { { "pid", process == null ? (int?)null : process.Id } };
                }
            }
            catch (Win32Exception error)
            {
                if (error.NativeErrorCode == ErrorCancelled)
                    return new Dictionary<string, object> { { "cancelled", true } };
                throw;
            }
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
