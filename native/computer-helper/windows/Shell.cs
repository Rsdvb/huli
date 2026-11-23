// Starting Windows' own programs (robocopy.exe, cmd.exe) through the administrator prompt.
//
// Process.Start with the runas verb asks ShellExecuteEx with no class, so the verb's command is read
// from HKEY_CLASSES_ROOT, where the user's HKCU\Software\Classes\exefile can put a command of its own
// behind the very prompt the owner expects. So the class key passed is HKLM\SOFTWARE\Classes\exefile,
// which only administrators write. A test build asks the same way with the open verb, which needs no
// prompt, so its tests run this code but for the verb.

using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Kite.ComputerHelper
{
    /// <summary>A process the shell started, held by its handle so its id stays its own.</summary>
    sealed class Launched : IDisposable
    {
        IntPtr handle;

        public Launched(IntPtr handle)
        {
            this.handle = handle;
            Id = Shell.GetProcessId(handle);
        }

        public int Id { get; private set; }

        public bool WaitForExit(int milliseconds)
        {
            return Shell.WaitForSingleObject(handle, (uint)milliseconds) == 0;
        }

        public int ExitCode
        {
            get
            {
                uint code;
                if (!Shell.GetExitCodeProcess(handle, out code)) throw Native.LastError("Reading an exit code");
                return unchecked((int)code);
            }
        }

        public void Dispose()
        {
            if (handle == IntPtr.Zero) return;
            Native.CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }

    static class Shell
    {
        const uint SEE_MASK_CLASSKEY = 0x00000003;
        const uint SEE_MASK_NOCLOSEPROCESS = 0x00000040;
        const uint SEE_MASK_NOASYNC = 0x00000100;
        const uint SEE_MASK_FLAG_NO_UI = 0x00000400;
        const int SW_HIDE = 0;
        public const int ErrorCancelled = 1223;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SHELLEXECUTEINFOW
        {
            public int cbSize;
            public uint fMask;
            public IntPtr hwnd;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpVerb;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpFile;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpParameters;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpDirectory;
            public int nShow;
            public IntPtr hInstApp;
            public IntPtr lpIDList;
            [MarshalAs(UnmanagedType.LPWStr)] public string lpClass;
            public IntPtr hkeyClass;
            public uint dwHotKey;
            public IntPtr hIconOrMonitor;
            public IntPtr hProcess;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool ShellExecuteExW(ref SHELLEXECUTEINFOW info);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int GetProcessId(IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr process, out uint code);

        /// <summary>
        /// Starts one of Windows' programs through the administrator prompt (open, with no prompt, in
        /// a test build), its verb read from HKLM's exefile class alone; throws a Win32Exception with
        /// code 1223 when the owner says no.
        /// </summary>
        public static Launched Start(string program, string arguments)
        {
            using (RegistryKey exefile = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Classes\exefile"))
            {
                if (exefile == null) throw new InvalidOperationException("Windows' class of programs is missing.");
                var info = new SHELLEXECUTEINFOW
                {
                    fMask = SEE_MASK_CLASSKEY | SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                    lpVerb = Build.Test ? "open" : "runas",
                    lpFile = program,
                    lpParameters = arguments,
                    lpDirectory = Guard.SystemDir(),
                    nShow = SW_HIDE,
                    hkeyClass = exefile.Handle.DangerousGetHandle(),
                };
                info.cbSize = Marshal.SizeOf(typeof(SHELLEXECUTEINFOW));
                if (!ShellExecuteExW(ref info))
                {
                    int code = Marshal.GetLastWin32Error();
                    throw new Win32Exception(code, "Starting " + System.IO.Path.GetFileName(program) + " failed (" + code + ")");
                }
                if (info.hProcess == IntPtr.Zero) throw new InvalidOperationException("Windows started no process.");
                return new Launched(info.hProcess);
            }
        }
    }
}
