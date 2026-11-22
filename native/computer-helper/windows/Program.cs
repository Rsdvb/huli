// kite-computer-helper: what Kite's computer use needs from Windows beyond Cua Driver.
//
//   serve   The warm helper, over stdin and stdout, one JSON object per line: which processes run
//           elevated, the system's text recognition, and the administrator prompt for the broker.
//   broker  The elevated broker the owner approved: a named pipe for Kite alone, relaying Cua
//           Driver's tools for one process's windows.
//
// See ../README.md.

using System;
using System.Reflection;

[assembly: AssemblyTitle("Kite computer use helper")]
[assembly: AssemblyProduct("Kite")]
[assembly: AssemblyDescription("Kite's computer use helper: elevation, text recognition and the elevated broker")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace Kite.ComputerHelper
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("usage: kite-computer-helper serve | broker <options>");
                return 2;
            }
            try
            {
                if (args[0] == "serve") return Serve.Run();
                if (args[0] == "broker") return Broker.Run(args);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                return 1;
            }
            Console.Error.WriteLine("unknown mode " + args[0]);
            return 2;
        }
    }
}
