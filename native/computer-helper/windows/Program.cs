// kite-computer-helper: what Kite's computer use needs from Windows beyond Cua Driver.
//
//   serve      The warm helper, over stdin and stdout, one JSON object per line: which processes
//              run elevated, the system's text recognition, and the administrator prompts below.
//   install    As administrator, from the app's folder: copies the helper and Cua Driver into
//              Program Files\Kite Computer Helper, checking the driver against the hash built in.
//   uninstall  As administrator: removes that folder.
//   broker     As administrator, from that folder only: drives one approved program's windows for
//              Kite after the owner confirms it in a window of its own.
//   connect    From that folder, without elevation: Kite's end of the broker's pipe, which checks the
//              pipe's server is that broker before Kite's token goes over it.
//
// See ../README.md.

using System;
using System.Collections.Generic;
using System.Reflection;

[assembly: AssemblyTitle("Kite computer use helper")]
[assembly: AssemblyProduct("Kite")]
[assembly: AssemblyDescription("Kite's computer use helper: elevation, text recognition and the elevated broker")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]

namespace Kite.ComputerHelper
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("usage: kite-computer-helper serve | install | uninstall | broker | connect");
                return 2;
            }
            try
            {
                if (args[0] == "serve") return Serve.Run();
                Dictionary<string, string> options;
                try
                {
                    options = Options(args);
                }
                catch (ArgumentException error)
                {
                    Console.Error.WriteLine(error.Message);
                    return 2;
                }
                if (args[0] == "install") return Install.Run(options);
                if (args[0] == "uninstall") return Install.Remove(options);
                if (args[0] == "broker") return Broker.Run(options);
                if (args[0] == "connect") return Connect.Run(options);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
            Console.Error.WriteLine("unknown mode " + args[0]);
            return 2;
        }

        /// <summary>`--name value` pairs after the mode, each name once.</summary>
        static Dictionary<string, string> Options(string[] args)
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            for (int i = 1; i < args.Length; i += 2)
            {
                if (i + 1 >= args.Length || !args[i].StartsWith("--")) throw new ArgumentException("Bad option " + args[i] + ".");
                string name = args[i].Substring(2);
                if (values.ContainsKey(name)) throw new ArgumentException("--" + name + " is given twice.");
                values[name] = args[i + 1];
            }
            return values;
        }
    }
}
