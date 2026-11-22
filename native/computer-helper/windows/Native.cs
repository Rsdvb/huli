// The Win32 calls the helper makes: process tokens, named pipes and window owners.

using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Kite.ComputerHelper
{
    static class Native
    {
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint SYNCHRONIZE = 0x00100000;
        const uint TOKEN_QUERY = 0x0008;
        const int TokenElevation = 20;
        const int TokenIntegrityLevel = 25;

        public const uint PIPE_ACCESS_DUPLEX = 0x00000003;
        public const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
        public const uint PIPE_TYPE_BYTE = 0x00000000;
        public const uint PIPE_READMODE_BYTE = 0x00000000;
        public const uint PIPE_WAIT = 0x00000000;
        public const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
        public const int ERROR_PIPE_CONNECTED = 535;
        public const uint WAIT_OBJECT_0 = 0;

        [StructLayout(LayoutKind.Sequential)]
        public struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int needed);

        [DllImport("advapi32.dll")]
        static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

        [DllImport("advapi32.dll")]
        static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string sddl, uint revision, out IntPtr descriptor, IntPtr size);

        [DllImport("kernel32.dll")]
        public static extern IntPtr LocalFree(IntPtr memory);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafePipeHandle CreateNamedPipeW(
            string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer,
            uint inBuffer, uint timeout, ref SECURITY_ATTRIBUTES attributes);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ConnectNamedPipe(SafePipeHandle pipe, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool DisconnectNamedPipe(SafePipeHandle pipe);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out int pid);

        [DllImport("user32.dll")]
        static extern int GetWindowThreadProcessId(IntPtr window, out int pid);

        [DllImport("user32.dll")]
        static extern bool IsWindow(IntPtr window);

        /// <summary>The process that owns a top-level window, or 0 when it is no window.</summary>
        public static int WindowOwner(long windowId)
        {
            if (windowId <= 0) return 0;
            var handle = new IntPtr(windowId);
            if (!IsWindow(handle)) return 0;
            int pid;
            GetWindowThreadProcessId(handle, out pid);
            return pid;
        }

        /// <summary>
        /// A process's mandatory integrity level (the integrity SID's last sub-authority, such as
        /// 0x2000 for medium and 0x3000 for high) and whether its token is elevated; null for what
        /// its token does not give this process.
        /// </summary>
        public static void TokenLevel(IntPtr process, out int? integrity, out bool? elevated)
        {
            integrity = null;
            elevated = null;
            IntPtr token;
            if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return;
            try
            {
                integrity = ReadIntegrity(token);
                elevated = ReadElevation(token);
            }
            finally
            {
                CloseHandle(token);
            }
        }

        /// <summary>The integrity level and elevation of the process with this id.</summary>
        public static void ProcessLevel(int pid, out int? integrity, out bool? elevated)
        {
            integrity = null;
            elevated = null;
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return;
            try
            {
                TokenLevel(process, out integrity, out elevated);
            }
            finally
            {
                CloseHandle(process);
            }
        }

        static int? ReadIntegrity(IntPtr token)
        {
            int needed;
            GetTokenInformation(token, TokenIntegrityLevel, IntPtr.Zero, 0, out needed);
            if (needed <= 0) return null;
            IntPtr buffer = Marshal.AllocHGlobal(needed);
            try
            {
                if (!GetTokenInformation(token, TokenIntegrityLevel, buffer, needed, out needed)) return null;
                // TOKEN_MANDATORY_LABEL starts with SID_AND_ATTRIBUTES, whose first field is the SID.
                IntPtr sid = Marshal.ReadIntPtr(buffer);
                int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0) return null;
                return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        static bool? ReadElevation(IntPtr token)
        {
            IntPtr buffer = Marshal.AllocHGlobal(4);
            try
            {
                int needed;
                if (!GetTokenInformation(token, TokenElevation, buffer, 4, out needed)) return null;
                return Marshal.ReadInt32(buffer) != 0;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        /// <summary>The user SID of the token of the process with this id, or null.</summary>
        public static string ProcessUser(int pid)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            try
            {
                IntPtr token;
                if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return null;
                try
                {
                    using (var identity = new WindowsIdentity(token))
                    {
                        return identity.User == null ? null : identity.User.Value;
                    }
                }
                finally
                {
                    CloseHandle(token);
                }
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                CloseHandle(process);
            }
        }

        public static Win32Exception LastError(string what)
        {
            int code = Marshal.GetLastWin32Error();
            return new Win32Exception(code, what + " failed (" + code + ")");
        }
    }
}
