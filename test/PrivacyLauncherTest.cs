using System;
using System.Diagnostics;
using System.IO;

internal static class PrivacyLauncherTest
{
    private static string node, script;
    private static int checks;

    private static void Check(bool value, string name)
    {
        if (!value) throw new Exception(name);
        checks++;
    }

    private static string Run(string mode, int timeout = 12000)
    {
        return ControlBackend.RunPrivacyBootstrap(new ProcessStartInfo(node, "\"" + script + "\" " + mode), timeout);
    }

    private static void Refuses(Action action, string name)
    {
        try { action(); }
        catch (Exception error)
        {
            Check(!error.Message.Contains("PRIVATE_TEST_CANARY"), name + " exposes child details");
            return;
        }
        throw new Exception(name + " must fail");
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            node = args[0]; script = args[1];
            string address = "http://127.0.0.1:43131/security";
            Check(Run("valid") == address, "configured vault launch");
            Check(Run("ticket") == address + "#setup=" + new string('x', 43), "first setup launch");
            Check(Run("large-stderr") == address, "both pipes are drained without deadlock");
            foreach (string mode in new string[] { "owner-mismatch", "private-error", "invalid-json", "untrusted-url", "missing-url", "large-output" })
                Refuses(() => Run(mode), mode);
            foreach (string url in new string[] { "https://example.test/security", "http://localhost:43131/security", address + "?redirect=example.test", address + "#setup=short", address + "#setup=" + new string('x', 42) + "\"" })
                Refuses(() => ControlBackend.ValidatePrivacyUrl(url), "URL allowlist");
            Stopwatch watch = Stopwatch.StartNew();
            Refuses(() => Run("timeout", 1500), "timeout");
            Check(watch.ElapsedMilliseconds < 5000, "timeout stays bounded");
            int pid = Int32.Parse(File.ReadAllText(Path.Combine(Path.GetDirectoryName(script), "timeout-pid.txt")));
            bool alive;
            try { using (Process child = Process.GetProcessById(pid)) alive = !child.HasExited; }
            catch (ArgumentException) { alive = false; }
            Check(!alive, "timed-out helper is terminated");
            Console.WriteLine("Privacy controller integration passed: " + checks + " checks.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }
}
