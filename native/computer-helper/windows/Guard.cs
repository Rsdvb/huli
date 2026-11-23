// What would load code into a .NET Framework program started as administrator, or bend where it
// finds Windows, looked for before any administrator prompt and again in the broker itself.
//
// A program started through the administrator prompt gets an environment Windows builds from the
// user's registry (HKCU\Environment and HKCU\Volatile Environment with its per-session subkeys),
// not the caller's. The runtime loads a profiler named there (COR_*), or another JIT or runtime
// (COMPlus_*), before Main runs, and reads the same knobs from HKCU\Software\Microsoft\.NETFramework.
// The serve process checks all of them before it asks Windows; the broker starts through cmd.exe,
// which is no .NET program, clears the code-loading names and sets SystemRoot and windir to the real
// Windows folder; and the broker's Main refuses to go on with any such name still there.

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Kite.ComputerHelper
{
    static class Guard
    {
        /// <summary>Prefixes of the runtime's own variables: profilers, JITs and runtime knobs.</summary>
        static readonly string[] Prefixes = { "COR_", "COMPLUS_", "CORECLR_" };

        /// <summary>
        /// DOTNET_ names the SDK sets for itself, which no .NET Framework program reads; every other
        /// DOTNET_ name is refused, as newer runtimes read their knobs under it.
        /// </summary>
        static readonly HashSet<string> SdkNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "DOTNET_ROOT", "DOTNET_ROOT(x86)", "DOTNET_ROOT_X86", "DOTNET_ROOT_X64", "DOTNET_ROOT_ARM64",
            "DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_NOLOGO", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE",
            "DOTNET_CLI_HOME", "DOTNET_CLI_UI_LANGUAGE", "DOTNET_MULTILEVEL_LOOKUP", "DOTNET_INSTALL_DIR",
            "DOTNET_GENERATE_ASPNET_CERTIFICATE", "DOTNET_PRINT_TELEMETRY_MESSAGE", "DOTNET_ENVIRONMENT",
            "DOTNET_HOST_PATH", "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH", "DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE",
        };

        /// <summary>The runtime's knobs under Software\Microsoft\.NETFramework that load or run code.</summary>
        static readonly HashSet<string> Knobs = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "AltJit", "AltJitName", "AltJitNgen", "JitName", "GCName", "InstallRoot", "Version",
            "DbgManagedDebugger", "DbgJITDebugLaunchSetting",
        };

        /// <summary>
        /// The variables the launcher clears before it starts the broker, as cmd.exe can name only
        /// fixed names: the profiler's, and the knobs that load another JIT, GC or runtime.
        /// </summary>
        public static readonly string[] Cleared =
        {
            "COR_ENABLE_PROFILING", "COR_PROFILER", "COR_PROFILER_PATH", "COR_PROFILER_PATH_32",
            "COR_PROFILER_PATH_64", "COMPLUS_ALTJIT", "COMPLUS_ALTJITNAME", "COMPLUS_ALTJITNGEN",
            "COMPLUS_JITNAME", "COMPLUS_GCNAME", "COMPLUS_INSTALLROOT", "COMPLUS_VERSION",
            "COMPLUS_DEFAULTVERSION", "CORECLR_ENABLE_PROFILING", "CORECLR_PROFILER",
            "CORECLR_PROFILER_PATH", "CORECLR_PROFILER_PATH_32", "CORECLR_PROFILER_PATH_64",
        };

        /// <summary>Whether a variable of this name makes a .NET runtime load code or change itself.</summary>
        public static bool LoadsCode(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            foreach (string prefix in Prefixes)
            {
                if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return name.StartsWith("DOTNET_", StringComparison.OrdinalIgnoreCase) && !SdkNames.Contains(name);
        }

        /// <summary>
        /// Why no program may be started as administrator now: a code-loading variable or knob in
        /// this process, the user's or the machine's environment, or the user's runtime settings, or
        /// a SystemRoot or windir the user set for themselves; null when there is none.
        /// </summary>
        public static string Unsafe()
        {
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                string name = (string)entry.Key;
                if (LoadsCode(name)) return Found(name, "Kite's own environment");
            }
            using (RegistryKey user = UserRoot())
            {
                if (user != null)
                {
                    string found = Variables(user, "Environment", @"HKCU\Environment");
                    if (found != null) return found;
                    using (RegistryKey volatileKey = user.OpenSubKey("Volatile Environment"))
                    {
                        if (volatileKey != null)
                        {
                            found = Variables(volatileKey, null, @"HKCU\Volatile Environment");
                            if (found != null) return found;
                            foreach (string session in volatileKey.GetSubKeyNames())
                            {
                                found = Variables(volatileKey, session, @"HKCU\Volatile Environment\" + session);
                                if (found != null) return found;
                            }
                        }
                    }
                    foreach (string path in new[] { @"Software\Microsoft\.NETFramework", @"Software\Wow6432Node\Microsoft\.NETFramework" })
                    {
                        found = RuntimeKnobs(user, path, @"HKCU\" + path);
                        if (found != null) return found;
                    }
                }
            }
            using (RegistryKey machine = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"))
            {
                if (machine != null)
                {
                    foreach (string name in machine.GetValueNames())
                    {
                        if (LoadsCode(name)) return Found(name, "the machine's environment");
                    }
                }
            }
            return null;
        }

        static string Variables(RegistryKey parent, string sub, string where)
        {
            using (RegistryKey key = sub == null ? null : parent.OpenSubKey(sub))
            {
                RegistryKey read = sub == null ? parent : key;
                if (read == null) return null;
                foreach (string name in read.GetValueNames())
                {
                    if (LoadsCode(name)) return Found(name, where);
                    // Windows' own folder is the machine's; a user's own SystemRoot or windir only
                    // points programs started as administrator at a folder of theirs.
                    if (string.Equals(name, "SystemRoot", StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(name, "windir", StringComparison.OrdinalIgnoreCase))
                    {
                        return "The variable " + name + " is set in " + where + ", which would point the administrator helper at another Windows folder.";
                    }
                }
                return null;
            }
        }

        static string RuntimeKnobs(RegistryKey parent, string path, string where)
        {
            using (RegistryKey key = parent.OpenSubKey(path))
            {
                if (key == null) return null;
                foreach (string name in key.GetValueNames())
                {
                    if (Knobs.Contains(name) || LoadsCode(name)) return Found(name, where);
                }
                return null;
            }
        }

        static string Found(string name, string where)
        {
            return "The .NET setting " + name + " is set in " + where + ", which would load code into the administrator helper.";
        }

        /// <summary>
        /// Why the broker may not go on with the environment it was started with: a code-loading name
        /// the launcher did not clear, or a SystemRoot or windir other than Windows' own folder.
        /// </summary>
        public static string BrokerEnvironment()
        {
            foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            {
                string name = (string)entry.Key;
                if (LoadsCode(name)) return "The .NET variable " + name + " is set in the broker's environment.";
            }
            string windows = WindowsDir();
            foreach (string name in new[] { "SystemRoot", "windir" })
            {
                string value = Environment.GetEnvironmentVariable(name);
                if (!SameFolder(value, windows)) return "The broker's " + name + " is not Windows' own folder.";
            }
            return null;
        }

        static bool SameFolder(string a, string b)
        {
            if (a == null || b == null) return false;
            return string.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetSystemWindowsDirectoryW(StringBuilder buffer, uint size);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
        static extern int RegLoadAppKeyW(string file, out IntPtr key, int access, int options, int reserved);

        /// <summary>Windows' own folder as the system knows it, never as an environment says.</summary>
        public static string WindowsDir()
        {
            var buffer = new StringBuilder(32768);
            uint length = GetSystemWindowsDirectoryW(buffer, (uint)buffer.Capacity);
            if (length == 0 || length >= buffer.Capacity) throw Native.LastError("Finding the Windows folder");
            return buffer.ToString(0, (int)length).TrimEnd('\\');
        }

        /// <summary>Windows' System32 folder, which GetSystemDirectory gives and no environment.</summary>
        public static string SystemDir()
        {
            return Environment.SystemDirectory;
        }

        /// <summary>
        /// The user's registry; a test build may read a private hive file in its place
        /// (KITE_HELPER_TEST_HIVE), so its tests never write the real one.
        /// </summary>
        static RegistryKey UserRoot()
        {
            if (Build.Test)
            {
                string hive = Environment.GetEnvironmentVariable("KITE_HELPER_TEST_HIVE");
                if (!string.IsNullOrEmpty(hive))
                {
                    IntPtr handle;
                    // KEY_READ.
                    int error = RegLoadAppKeyW(hive, out handle, 0x20019, 0, 0);
                    if (error != 0) throw new IOException("The test hive did not load (" + error + ").");
                    return RegistryKey.FromHandle(new SafeRegistryHandle(handle, true));
                }
            }
            return Registry.CurrentUser.OpenSubKey("", false);
        }
    }
}
