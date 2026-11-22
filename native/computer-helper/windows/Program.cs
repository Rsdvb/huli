// kite-computer-helper: what Kite's computer use needs from Windows beyond Cua Driver.
//
//   serve   The warm helper, over stdin and stdout, one JSON object per line: which processes run
//           elevated, and the system's text recognition.
//
// See ../README.md.

using System;
using System.Reflection;

[assembly: AssemblyTitle("Kite computer use helper")]
[assembly: AssemblyProduct("Kite")]
[assembly: AssemblyDescription("Kite's computer use helper: elevation and text recognition")]
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
                Console.Error.WriteLine("usage: kite-computer-helper serve");
                return 2;
            }
            try
            {
                if (args[0] == "serve") return Serve.Run();
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
