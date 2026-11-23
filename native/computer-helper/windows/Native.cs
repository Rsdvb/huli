// The Win32 calls the helper makes: process tokens, images, times and parents, named pipes, job
// objects and window owners.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Kite.ComputerHelper
{
    static class Native
    {
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint PROCESS_SET_QUOTA = 0x0100;
        public const uint PROCESS_TERMINATE = 0x0001;
        public const uint SYNCHRONIZE = 0x00100000;
        const uint TOKEN_QUERY = 0x0008;
        const int TokenElevation = 20;
        const int TokenIntegrityLevel = 25;
        public const int HighIntegrity = 0x3000;

        public const uint PIPE_ACCESS_DUPLEX = 0x00000003;
        public const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
        public const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        public const uint PIPE_TYPE_BYTE = 0x00000000;
        public const uint PIPE_READMODE_BYTE = 0x00000000;
        public const uint PIPE_WAIT = 0x00000000;
        public const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;

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

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        [DllImport("advapi32.dll", SetLastError = true)]
        static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int needed);

        [DllImport("advapi32.dll")]
        static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);

        [DllImport("advapi32.dll")]
        static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

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
        public static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out int pid);

        [DllImport("user32.dll")]
        static extern int GetWindowThreadProcessId(IntPtr window, out int pid);

        [DllImport("user32.dll")]
        static extern bool IsWindow(IntPtr window);

        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left, Top, Right, Bottom;
        }

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr window, out RECT rect);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);

        // Job objects: the driver dies with the broker, and the approved program starts no process.
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);

        const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        /// <summary>Sets a job's limits: the flags, and the most processes it may hold.</summary>
        public static void LimitJob(IntPtr job, uint flags, uint activeProcesses)
        {
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = flags;
            info.BasicLimitInformation.ActiveProcessLimit = activeProcesses;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info)))
                throw LastError("Setting a job's limits");
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateToolhelp32Snapshot(uint flags, int pid);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct PROCESSENTRY32
        {
            public int dwSize;
            public int cntUsage;
            public int th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public int th32ModuleID;
            public int cntThreads;
            public int th32ParentProcessID;
            public int pcPriClassBase;
            public int dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        /// <summary>The process that started the process with this id, or 0 when none is found.</summary>
        public static int ParentOf(int pid)
        {
            IntPtr snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return 0;
            try
            {
                var entry = new PROCESSENTRY32 { dwSize = Marshal.SizeOf(typeof(PROCESSENTRY32)) };
                for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry))
                {
                    if (entry.th32ProcessID == pid) return entry.th32ParentProcessID;
                }
                return 0;
            }
            finally
            {
                CloseHandle(snapshot);
            }
        }

        /// <summary>
        /// The live processes that the process with this id started after it started itself: its
        /// children, and theirs in turn.
        /// </summary>
        public static List<int> Descendants(int pid)
        {
            var found = new List<int>();
            IntPtr snapshot = CreateToolhelp32Snapshot(0x00000002, 0);
            if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return found;
            var parents = new Dictionary<int, int>();
            try
            {
                var entry = new PROCESSENTRY32 { dwSize = Marshal.SizeOf(typeof(PROCESSENTRY32)) };
                for (bool more = Process32FirstW(snapshot, ref entry); more; more = Process32NextW(snapshot, ref entry))
                {
                    parents[entry.th32ProcessID] = entry.th32ParentProcessID;
                }
            }
            finally
            {
                CloseHandle(snapshot);
            }
            var queue = new Queue<int>();
            queue.Enqueue(pid);
            while (queue.Count > 0 && found.Count < 4096)
            {
                int parent = queue.Dequeue();
                long parentStarted = StartedAt(parent);
                foreach (KeyValuePair<int, int> child in parents)
                {
                    if (child.Value != parent || child.Key == parent || found.Contains(child.Key)) continue;
                    // A parent id a later process took again names no child of this one.
                    long started = StartedAt(child.Key);
                    if (started == 0 || parentStarted == 0 || started < parentStarted) continue;
                    found.Add(child.Key);
                    queue.Enqueue(child.Key);
                }
            }
            return found;
        }

        [DllImport("ntdll.dll")]
        static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);

        const int ProcessCommandLineInformation = 60;

        /// <summary>The command line of the process with this id, or null.</summary>
        public static string CommandLine(int pid)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            try
            {
                int needed;
                NtQueryInformationProcess(process, ProcessCommandLineInformation, IntPtr.Zero, 0, out needed);
                if (needed <= 0 || needed > (1 << 20)) return null;
                IntPtr buffer = Marshal.AllocHGlobal(needed);
                try
                {
                    if (NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer, needed, out needed) != 0) return null;
                    // UNICODE_STRING: its length in bytes, its capacity, then the pointer, aligned.
                    int length = (ushort)Marshal.ReadInt16(buffer);
                    IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
                    return text == IntPtr.Zero ? null : Marshal.PtrToStringUni(text, length / 2);
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
            }
            finally
            {
                CloseHandle(process);
            }
        }

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        static extern IntPtr GetWindow(IntPtr window, uint command);

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr window);

        [DllImport("dwmapi.dll")]
        static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

        /// <summary>
        /// The process of a visible window above this one in the z-order that overlaps it, layered
        /// and transparent ones included, or 0 when none does; this process's own windows aside.
        /// </summary>
        public static int CoveringProcess(IntPtr window)
        {
            RECT mine;
            if (!GetWindowRect(window, out mine)) return 0;
            int self = System.Diagnostics.Process.GetCurrentProcess().Id;
            int seen = 0;
            // GW_HWNDPREV: the window above.
            for (IntPtr other = GetWindow(window, 3); other != IntPtr.Zero && seen < 10000; other = GetWindow(other, 3), seen++)
            {
                if (!IsWindowVisible(other)) continue;
                int cloaked;
                // DWMWA_CLOAKED: windows of other virtual desktops and suspended apps draw nothing.
                if (DwmGetWindowAttribute(other, 14, out cloaked, 4) == 0 && cloaked != 0) continue;
                int pid;
                GetWindowThreadProcessId(other, out pid);
                if (pid == self) continue;
                RECT rect;
                if (!GetWindowRect(other, out rect)) continue;
                if (rect.Right <= mine.Left || rect.Left >= mine.Right || rect.Bottom <= mine.Top || rect.Top >= mine.Bottom) continue;
                return pid == 0 ? -1 : pid;
            }
            return 0;
        }

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

        /// <summary>Whether this process runs at high integrity or above.</summary>
        public static bool SelfIsHigh()
        {
            int? integrity;
            bool? elevated;
            TokenLevel(GetCurrentProcess(), out integrity, out elevated);
            return integrity.HasValue && integrity.Value >= HighIntegrity;
        }

        /// <summary>Whether the process with this id runs at high integrity or above.</summary>
        public static bool IsHigh(int pid)
        {
            int? integrity;
            bool? elevated;
            ProcessLevel(pid, out integrity, out elevated);
            return integrity.HasValue && integrity.Value >= HighIntegrity;
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

        /// <summary>The full path of the image of the process with this id, or null.</summary>
        public static string ImageOf(int pid)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return null;
            try
            {
                var name = new StringBuilder(32768);
                int size = name.Capacity;
                return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString(0, size) : null;
            }
            finally
            {
                CloseHandle(process);
            }
        }

        /// <summary>When the process with this id started, as a FILETIME, or 0.</summary>
        public static long StartedAt(int pid)
        {
            IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return 0;
            try
            {
                long creation, exit, kernel, user;
                return GetProcessTimes(process, out creation, out exit, out kernel, out user) ? creation : 0;
            }
            finally
            {
                CloseHandle(process);
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
