// Where the elevated helper lives, and its install there. Programs that run as administrator must
// not come from a folder the user can write to, as the app's own folder is in a per-user install:
// anything of the user's could swap them, or plant a DLL or an .exe.config beside them. So the helper
// and Cua Driver are copied once, at the owner's request, into Program Files, which only
// administrators can write to, and Kite only ever starts that copy as administrator.
//
// No program from the app's folder runs as administrator for that: the copy is Windows' own
// robocopy.exe, from a staging folder this process fills, and the removal Windows' own cmd.exe. The
// staging folder is the user's, so this process holds it and the staged files open until robocopy
// is done, which keeps other programs from changing them in passing. The boundary is the record:
// the elevated command line itself writes install.txt (the protocol, the hashes of the held files
// and Kite's program), so what an install should hold is fixed in the very command the owner
// approved, in a folder only administrators write. Every look and every start checks the installed
// files against it and the folder's rights, so a copy that is not the staged one reads tampered for
// as long as it is there.
// A newer Kite keeps using the installed copy while its protocol is the same, so an update asks for
// no new install.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Kite.ComputerHelper
{
    static class Layout
    {
        public const string FolderName = "Kite Computer Helper";
        public const string HelperFile = "kite-computer-helper.exe";
        public const string DriverFile = "cua-driver.exe";
        /// <summary>
        /// The install's record, which the elevated command line writes: one line of the protocol, the
        /// helper's and the driver's SHA-256 and Kite's program as UTF-8 in hex, so cmd.exe's echo
        /// writes it as it is, with nothing to escape and no code page to mind.
        /// </summary>
        public const string RecordFile = "install.txt";
        /// <summary>The driver's own home and temporary folders, which only administrators reach.</summary>
        public const string HomeFolder = "home";
        /// <summary>
        /// What the broker and Kite speak; an install of another protocol is outdated. Raised only
        /// when the broker's checks change, so a reinstall prompt stays rare and stands out.
        /// </summary>
        public const int Protocol = 2;

        /// <summary>
        /// Program Files\Kite Computer Helper; a test build may name another folder, so its tests run
        /// without the administrator prompt.
        /// </summary>
        public static string InstallDir(string other)
        {
            if (other != null)
            {
                if (!Build.Test) throw new ArgumentException("This build installs only into Program Files.");
                return Path.GetFullPath(other);
            }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), FolderName);
        }

        public static string OwnPath()
        {
            return Process.GetCurrentProcess().MainModule.FileName;
        }

        public static bool SamePath(string a, string b)
        {
            if (a == null || b == null) return false;
            return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>Opens a file so that no one can write, rename or delete it while it is held.</summary>
        public static FileStream Hold(string path)
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        }

        public static string Sha256(Stream stream)
        {
            stream.Position = 0;
            using (var sha = SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(stream);
                var hex = new StringBuilder(hash.Length * 2);
                foreach (byte b in hash) hex.Append(b.ToString("x2"));
                stream.Position = 0;
                return hex.ToString();
            }
        }

        public static string Sha256(string path)
        {
            using (var held = Hold(path)) return Sha256(held);
        }

        /// <summary>Whether a path is a directory that is no junction or symbolic link.</summary>
        public static bool PlainDirectory(string path)
        {
            return Directory.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;
        }

        /// <summary>The install's record, or null when it is missing or unreadable.</summary>
        public static Record ReadRecord(string dir)
        {
            string path = Path.Combine(dir, RecordFile);
            if (!File.Exists(path)) return null;
            try
            {
                string[] parts = File.ReadAllText(path, Encoding.ASCII).Trim().Split(' ');
                int protocol;
                if (parts.Length != 4 || !int.TryParse(parts[0], out protocol) || !Hash.IsMatch(parts[1]) || !Hash.IsMatch(parts[2]) ||
                    parts[3].Length % 2 != 0 || !HexText.IsMatch(parts[3]))
                    return null;
                var client = new byte[parts[3].Length / 2];
                for (int i = 0; i < client.Length; i++) client[i] = Convert.ToByte(parts[3].Substring(i * 2, 2), 16);
                return new Record { Protocol = protocol, HelperSha256 = parts[1], DriverSha256 = parts[2], Client = new UTF8Encoding(false, true).GetString(client) };
            }
            catch (Exception)
            {
                return null;
            }
        }

        static readonly System.Text.RegularExpressions.Regex Hash = new System.Text.RegularExpressions.Regex(@"\A[0-9a-f]{64}\z");
        static readonly System.Text.RegularExpressions.Regex HexText = new System.Text.RegularExpressions.Regex(@"\A[0-9a-f]{2,4000}\z");

        /// <summary>The record's line as the elevated command writes it.</summary>
        public static string RecordLine(Record record)
        {
            var hex = new StringBuilder();
            foreach (byte b in new UTF8Encoding(false).GetBytes(record.Client)) hex.Append(b.ToString("x2"));
            if (hex.Length > 4000) throw new ArgumentException("Kite's program has too long a path to record.");
            return record.Protocol + " " + record.HelperSha256 + " " + record.DriverSha256 + " " + hex;
        }

        /// <summary>
        /// What the install folder holds against what this helper expects: missing; outdated (an
        /// older protocol, an install from before the record, or another Kite program); tampered (a
        /// file that is not the one recorded, or rights that let others than administrators change
        /// it); or current.
        /// </summary>
        public static Dictionary<string, object> State(string dir, string client)
        {
            string helper = Path.Combine(dir, HelperFile);
            string driver = Path.Combine(dir, DriverFile);
            var state = new Dictionary<string, object> { { "installDir", dir }, { "protocol", Protocol } };
            if (!PlainDirectory(dir) || !File.Exists(helper))
            {
                state["state"] = "missing";
                return state;
            }
            Record record = ReadRecord(dir);
            if (record == null || record.Protocol != Protocol || !File.Exists(driver))
            {
                state["state"] = "outdated";
                return state;
            }
            state["state"] = Check(dir, record) ?? (client == null || SamePath(record.Client, client) ? "current" : "outdated");
            return state;
        }

        /// <summary>"tampered" when the installed files are not the recorded ones or the folder's rights are loose; null when sound.</summary>
        static string Check(string dir, Record record)
        {
            try
            {
                if (Sha256(Path.Combine(dir, HelperFile)) != record.HelperSha256 || Sha256(Path.Combine(dir, DriverFile)) != record.DriverSha256)
                    return "tampered";
            }
            catch (IOException)
            {
                return "tampered";
            }
            return Build.Test || Protected(dir) ? null : "tampered";
        }

        static readonly HashSet<string> Trusted = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            // Administrators, SYSTEM and TrustedInstaller.
            "S-1-5-32-544", "S-1-5-18", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
        };

        // Rights that change a file or folder, its contents, its rights or its owner.
        const int ChangingRights =
            0x0002 /* write data, add file */ | 0x0004 /* append, add subfolder */ | 0x0010 /* write EA */ |
            0x0040 /* delete child */ | 0x0100 /* write attributes */ | 0x10000 /* delete */ |
            0x40000 /* WRITE_DAC */ | 0x80000 /* WRITE_OWNER */ | 0x10000000 /* GENERIC_ALL */ |
            0x40000000 /* GENERIC_WRITE */;

        /// <summary>
        /// Whether only administrators, SYSTEM and TrustedInstaller own and may change the install
        /// folder, its parent, the files Kite runs and the record.
        /// </summary>
        public static bool Protected(string dir)
        {
            try
            {
                string parent = Path.GetDirectoryName(dir.TrimEnd('\\'));
                if (parent == null || !OnlyAdmins(Directory.GetAccessControl(parent))) return false;
                if (!OnlyAdmins(Directory.GetAccessControl(dir))) return false;
                foreach (string name in new[] { HelperFile, DriverFile, RecordFile })
                {
                    string path = Path.Combine(dir, name);
                    if (File.Exists(path) && !OnlyAdmins(File.GetAccessControl(path))) return false;
                }
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        static bool OnlyAdmins(FileSystemSecurity security)
        {
            var owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            if (owner == null || !Trusted.Contains(owner.Value)) return false;
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                // CREATOR OWNER and the like apply only to what is created inside, by an administrator.
                if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                if (((int)rule.FileSystemRights & ChangingRights) == 0) continue;
                if (!Trusted.Contains(rule.IdentityReference.Value)) return false;
            }
            return true;
        }

        /// <summary>
        /// Makes the driver's home and temporary folders under the install folder when missing, with
        /// rights for administrators and SYSTEM alone; false when one is a link.
        /// </summary>
        public static bool MakeHome(string dir)
        {
            string home = Path.Combine(dir, HomeFolder);
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            security.SetOwner(new SecurityIdentifier("S-1-5-32-544"));
            foreach (string sid in new[] { "S-1-5-32-544", "S-1-5-18" })
            {
                security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            }
            if (Directory.Exists(home))
            {
                if (!PlainDirectory(home)) return false;
            }
            else if (Build.Test)
            {
                Directory.CreateDirectory(home);
            }
            else
            {
                Directory.CreateDirectory(home, security);
            }
            foreach (string sub in new[] { "Local", "Roaming", "Temp" })
            {
                string path = Path.Combine(home, sub);
                if (Directory.Exists(path) && !PlainDirectory(path)) return false;
                Directory.CreateDirectory(path);
            }
            return true;
        }
    }

    sealed class Record
    {
        public int Protocol;
        public string HelperSha256;
        public string DriverSha256;
        public string Client;
    }

    /// <summary>
    /// The staging folder robocopy copies from: this helper and the driver beside it. While it lives,
    /// the folder is held open with no delete sharing and each staged file read-only with read
    /// sharing alone, and the hashes are of those held handles. A program of the user's can still
    /// close this process's handles, so this only keeps the copy from changing in passing; the record
    /// the elevated command writes is what holds.
    /// </summary>
    sealed class Staged : IDisposable
    {
        public readonly string Dir;
        public readonly Record Record;
        readonly List<FileStream> held = new List<FileStream>();
        SafeFileHandle folder;

        Staged(string dir, Record record)
        {
            Dir = dir;
            Record = record;
        }

        const uint FILE_LIST_DIRECTORY = 0x0001;
        const uint FILE_SHARE_READ = 0x1;
        const uint FILE_SHARE_WRITE = 0x2;
        const uint OPEN_EXISTING = 3;
        const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        public static Staged Fill(string client)
        {
            string own = Layout.OwnPath();
            string sourceDriver = Path.Combine(Path.GetDirectoryName(own), Layout.DriverFile);
            string dir = Path.Combine(Path.GetTempPath(), "kite-helper-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            var staged = new Staged(dir, null);
            try
            {
                staged.folder = CreateFileW(dir, FILE_LIST_DIRECTORY, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
                if (staged.folder.IsInvalid) throw Native.LastError("Holding the staging folder");
                if (!Layout.PlainDirectory(dir) || Directory.GetFileSystemEntries(dir).Length > 0) throw new InvalidOperationException("The staging folder is not a new, empty folder.");
                Record record;
                using (FileStream helper = Layout.Hold(own))
                using (FileStream driver = Layout.Hold(sourceDriver))
                {
                    string driverSha = Layout.Sha256(driver);
                    if (driverSha != Build.DriverSha256) throw new InvalidOperationException("cua-driver.exe is not the one this helper was built with.");
                    record = new Record { Protocol = Layout.Protocol, HelperSha256 = Layout.Sha256(helper), DriverSha256 = driverSha, Client = Path.GetFullPath(client) };
                    Copy(helper, Path.Combine(dir, Layout.HelperFile));
                    Copy(driver, Path.Combine(dir, Layout.DriverFile));
                }
                // Held from here until robocopy is done, and checked as held: what was swapped in the
                // moment between writing and holding is caught here.
                staged.Keep(Layout.HelperFile, record.HelperSha256);
                staged.Keep(Layout.DriverFile, record.DriverSha256);
                var done = new Staged(dir, record) { folder = staged.folder };
                done.held.AddRange(staged.held);
                staged.held.Clear();
                staged.folder = null;
                return done;
            }
            catch
            {
                staged.Dispose();
                throw;
            }
        }

        void Keep(string name, string expected)
        {
            var stream = new FileStream(Path.Combine(Dir, name), FileMode.Open, FileAccess.Read, FileShare.Read);
            held.Add(stream);
            if (Layout.Sha256(stream) != expected) throw new InvalidOperationException("The staged copy changed before it could be held.");
        }

        static string Hex(byte[] hash)
        {
            var hex = new StringBuilder(hash.Length * 2);
            foreach (byte b in hash) hex.Append(b.ToString("x2"));
            return hex.ToString();
        }

        static void Copy(FileStream from, string to)
        {
            from.Position = 0;
            using (var target = new FileStream(to, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                from.CopyTo(target);
                target.Flush(true);
            }
        }

        /// <summary>Lets go of the files and the folder, then removes them.</summary>
        public void Dispose()
        {
            foreach (FileStream stream in held) stream.Dispose();
            held.Clear();
            if (folder != null) folder.Dispose();
            folder = null;
            try
            {
                foreach (string file in Directory.GetFiles(Dir)) File.Delete(file);
                Directory.Delete(Dir, false);
            }
            catch (Exception)
            {
                // The temporary folder's cleanup takes it later.
            }
        }

        /// <summary>Whether the install holds exactly what was staged and recorded, as hashed while held.</summary>
        public bool Landed(string installDir)
        {
            Record found = Layout.ReadRecord(installDir);
            if (found == null || found.Protocol != Record.Protocol || found.HelperSha256 != Record.HelperSha256 ||
                found.DriverSha256 != Record.DriverSha256 || !string.Equals(found.Client, Record.Client, StringComparison.Ordinal))
                return false;
            try
            {
                return Layout.Sha256(Path.Combine(installDir, Layout.HelperFile)) == Record.HelperSha256 &&
                    Layout.Sha256(Path.Combine(installDir, Layout.DriverFile)) == Record.DriverSha256;
            }
            catch (IOException)
            {
                return false;
            }
        }
    }
}
