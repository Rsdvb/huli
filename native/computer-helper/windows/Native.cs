// The Win32 calls the helper makes: process tokens.

using System;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Kite.ComputerHelper
{
    static class Native
    {
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        const uint TOKEN_QUERY = 0x0008;
        const int TokenElevation = 20;
        const int TokenIntegrityLevel = 25;

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int needed);

        [DllImport("advapi32.dll")]
        static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

        [DllImport("advapi32.dll")]
        static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

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
    }
}
