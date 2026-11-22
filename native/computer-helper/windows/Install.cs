// Where the elevated helper lives, and its one-time install there. Programs that run as
// administrator must not come from a folder the user can write to, as the app's own folder is in a
// per-user install: anything of the user's could swap them, or plant a DLL or an .exe.config beside
// them, and run as administrator at the next approved prompt. So the owner installs the helper and
// Cua Driver once, through the administrator prompt, into Program Files, which only administrators
// can write to; Kite then only ever starts that copy as administrator. The driver's SHA-256 is built
// into the helper (Build.cs, written by build.mjs), and every copy and start checks it while the
// file is held open so no one can change it in between.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Kite.ComputerHelper
{
    static class Layout
    {
        public const string FolderName = "Kite Computer Helper";
        public const string HelperFile = "kite-computer-helper.exe";
        public const string DriverFile = "cua-driver.exe";
        /// <summary>The Kite program that may ask the installed helper for anything, one path.</summary>
        public const string ClientFile = "client.txt";
        /// <summary>The driver's own home and temporary folders, which only administrators write to.</summary>
        public const string HomeFolder = "home";

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

        /// <summary>
        /// What the install folder holds against what this helper expects: present, the same helper
        /// as this one, the driver this one was built with, and the Kite program `client` recorded.
        /// </summary>
        public static Dictionary<string, object> State(string dir, string client)
        {
            string helper = Path.Combine(dir, HelperFile);
            string driver = Path.Combine(dir, DriverFile);
            string recorded = Path.Combine(dir, ClientFile);
            var state = new Dictionary<string, object> { { "installDir", dir } };
            if (!PlainDirectory(dir) || !File.Exists(helper) || !File.Exists(driver) || !File.Exists(recorded))
            {
                state["state"] = "missing";
                return state;
            }
            bool same = Sha256(helper) == Sha256(OwnPath()) && Sha256(driver) == Build.DriverSha256;
            bool forClient = client == null || SamePath(File.ReadAllText(recorded, Encoding.UTF8).Trim(), client);
            state["state"] = same && forClient ? "current" : "outdated";
            return state;
        }
    }

    static class Install
    {
        /// <summary>`install --client-image PATH`: copies this helper and the driver into place.</summary>
        public static int Run(Dictionary<string, string> options)
        {
            if (!Build.Test && !Native.SelfIsHigh()) return Fail(9, "The install runs as administrator only.");
            string client;
            if (!options.TryGetValue("client-image", out client) || !ValidClient(client)) return Fail(2, "--client-image must name Kite's program.");
            string other;
            options.TryGetValue("install-dir", out other);
            string dir = Layout.InstallDir(other);
            string own = Layout.OwnPath();
            string sourceDriver = Path.Combine(Path.GetDirectoryName(own), Layout.DriverFile);
            using (FileStream helper = Layout.Hold(own))
            using (FileStream driver = Layout.Hold(sourceDriver))
            {
                if (Layout.Sha256(driver) != Build.DriverSha256) return Fail(10, "cua-driver.exe is not the one this helper was built with.");
                string helperSha = Layout.Sha256(helper);
                if (Directory.Exists(dir) && !Layout.PlainDirectory(dir)) return Fail(11, "The install folder is a link.");
                if (Directory.Exists(dir)) Empty(dir);
                Directory.CreateDirectory(dir);
                // The folder inherits Program Files' rights: administrators write, users read.
                Copy(helper, Path.Combine(dir, Layout.HelperFile));
                Copy(driver, Path.Combine(dir, Layout.DriverFile));
                File.WriteAllText(Path.Combine(dir, Layout.ClientFile), Path.GetFullPath(client), new UTF8Encoding(false));
                string home = Path.Combine(dir, Layout.HomeFolder);
                foreach (string sub in new[] { "Local", "Roaming", "Temp" }) Directory.CreateDirectory(Path.Combine(home, sub));
                if (Layout.Sha256(Path.Combine(dir, Layout.HelperFile)) != helperSha ||
                    Layout.Sha256(Path.Combine(dir, Layout.DriverFile)) != Build.DriverSha256)
                {
                    return Fail(12, "The installed copies do not match.");
                }
            }
            return 0;
        }

        /// <summary>`uninstall`: removes the install folder.</summary>
        public static int Remove(Dictionary<string, string> options)
        {
            if (!Build.Test && !Native.SelfIsHigh()) return Fail(9, "The removal runs as administrator only.");
            string other;
            options.TryGetValue("install-dir", out other);
            string dir = Layout.InstallDir(other);
            if (!Directory.Exists(dir)) return 0;
            if (!Layout.PlainDirectory(dir)) return Fail(11, "The install folder is a link.");
            Empty(dir);
            Directory.Delete(dir);
            return 0;
        }

        static bool ValidClient(string path)
        {
            return path != null && path.Length < 32768 && Path.IsPathRooted(path) &&
                path.IndexOfAny(new[] { '\r', '\n', '"' }) < 0 &&
                string.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase) &&
                File.Exists(path);
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

        /// <summary>Deletes what a folder holds, removing links themselves and never what they point to.</summary>
        static void Empty(string dir)
        {
            foreach (string file in Directory.GetFiles(dir))
            {
                File.SetAttributes(file, FileAttributes.Normal);
                File.Delete(file);
            }
            foreach (string sub in Directory.GetDirectories(dir))
            {
                if ((File.GetAttributes(sub) & FileAttributes.ReparsePoint) != 0)
                {
                    Directory.Delete(sub, false);
                    continue;
                }
                Empty(sub);
                Directory.Delete(sub, false);
            }
        }

        static int Fail(int code, string message)
        {
            Console.Error.WriteLine(message);
            return code;
        }
    }
}
