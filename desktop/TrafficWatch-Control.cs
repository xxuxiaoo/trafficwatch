using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("TrafficWatch 流量中心")]
[assembly: AssemblyDescription("Start, stop and inspect the local TrafficWatch collectors and tray")]
[assembly: AssemblyProduct("TrafficWatch Control")]
[assembly: AssemblyVersion("1.0.0.0")]

internal sealed class ControlSnapshot
{
    public string Machine = "读取中", Clash = "读取中", Supervisor = "读取中", Tray = "读取中", Capture = "读取中", Startup = "读取中";
    public string Headline = "正在检查实际状态…";
    public string Diagnostics = "读取中", Bypass = "读取中";
    public bool Running, Pending, CapturePaused;
}

internal static class ControlBackend
{
    internal static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "TrafficWatch");
    internal const string BackgroundTask = "TrafficWatch - Open-source Netwatch";
    internal const string TrayTask = "TrafficWatch - Tray";
    internal static readonly string PowerShell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");

    internal static string ReadHealth(int port, out bool online)
    {
        online = false;
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/health");
            request.Proxy = null; request.Timeout = 650; request.ReadWriteTimeout = 650;
            request.AllowAutoRedirect = false; request.KeepAlive = false;
            using (WebResponse response = request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                char[] buffer = new char[8193];
                int count = reader.ReadBlock(buffer, 0, buffer.Length);
                if (count > 8192) return "接口响应异常";
                var packet = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(new string(buffer, 0, count));
                object app, state;
                if (!packet.TryGetValue("app", out app) || Convert.ToString(app) != "codex-flow") return "端口被其他程序占用";
                online = true;
                packet.TryGetValue("state", out state);
                if (Convert.ToString(state) == "connected") return "正在记录";
                if (Convert.ToString(state) == "starting") return "服务启动中";
                return port == 43130 ? "服务运行，等待 Clash 接口" : "服务运行，采集源未连接";
            }
        }
        catch { return "服务未运行或无响应"; }
    }

    private static bool HasProcess(string name)
    {
        Process[] processes = Process.GetProcessesByName(name);
        try { return processes.Length > 0; }
        finally { foreach (Process process in processes) process.Dispose(); }
    }

    internal static ControlSnapshot ReadStatus()
    {
        ControlSnapshot result = new ControlSnapshot();
        bool machineOnline, clashOnline;
        result.Machine = ReadHealth(43128, out machineOnline);
        result.Clash = ReadHealth(43130, out clashOnline);
        bool capture = HasProcess("Codex-Netwatch-Capture"), tray = HasProcess("TrafficWatch-Tray");
        result.Capture = capture ? "运行中" : "未运行";
        result.Tray = tray ? "图标进程运行中" : "未运行";
        try {
            var request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:43132/api/health");request.Proxy=null;request.Timeout=650;request.ReadWriteTimeout=650;
            using(var response=request.GetResponse()) using(var reader=new StreamReader(response.GetResponseStream())) {
                var data=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
                result.Diagnostics=Convert.ToString(data["app"])=="trafficwatch-ai-diagnostics"?"运行中（独立于流量统计）":"端口异常";
            }
        } catch {result.Diagnostics="未运行或无响应";}
        try {
            var settings=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(Root,"suite-settings.json")));
            string dataRoot = Convert.ToString(settings["DataRoot"]);
            result.CapturePaused = File.Exists(Path.Combine(dataRoot, "capture-paused"));
            var state=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(dataRoot,@"relay-bypass\status.json")));
            string value=Convert.ToString(state["state"]);long at=Convert.ToInt64(state["at"]);
            result.Bypass=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-at>150000?"状态过期，请打开连接诊断复查":value=="verified"?"物理绕行已验证":value=="rolled_back"?"已恢复原 Clash DIRECT 路径":value=="stopped"?"辅助已停止（保留已有路由）":"正在校验 / 部分未通过";
        }catch{result.Bypass="尚未启用 / 无状态";}
        bool taskKnown = false, supervisor = false;
        object service = null, folder = null, task = null, trayTask = null;
        try
        {
            service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            dynamic scheduler = service;
            scheduler.Connect();
            folder = scheduler.GetFolder(@"\");
            dynamic taskFolder = folder;
            task = taskFolder.GetTask(BackgroundTask);
            dynamic background = task;
            bool enabled = background.Enabled;
            int state = background.State;
            taskKnown = true; supervisor = state == 4;
            result.Supervisor = supervisor ? "运行中（会自动拉起采集）" : state == 2 ? "已排队，准备启动" : "未运行";
            result.Pending = state == 2;
            trayTask = taskFolder.GetTask(TrayTask);
            dynamic desktopTask = trayTask;
            bool trayEnabled = desktopTask.Enabled;
            result.Startup = enabled
                ? "开机采集：开启；登录托盘：" + (trayEnabled ? "开启" : "关闭")
                : "开机采集：关闭；登录托盘：" + (trayEnabled ? "开启" : "关闭");
        }
        catch { result.Supervisor = "任务状态无法读取"; result.Startup = "无法读取，请以管理员身份查看"; }
        finally
        {
            foreach (object value in new object[] { trayTask, task, folder, service })
                if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }
        result.Running = machineOnline || clashOnline || capture || supervisor;
        if (machineOnline && clashOnline) result.Headline = "两路采集服务均已运行";
        else if (result.Running || result.Pending) result.Headline = "部分组件仍在运行或正在启动";
        else if (!taskKnown) result.Headline = "采集接口未响应，守护状态待确认";
        else result.Headline = tray ? "采集后台已停止，托盘仍运行" : "采集后台和托盘均已停止";
        return result;
    }

    internal static int RunAction(string action, bool elevate)
    {
        if (action != "Start" && action != "Stop" && action != "StopFromOverview" && action != "PauseCapture" && action != "EnableStartup" && action != "DisableStartup" && action != "StartDiagnostics" && action != "StopDiagnostics" && action != "EnableBypass" && action != "RollbackBypass")
            throw new ArgumentException("Unsupported control action.");
        string script = Path.Combine(Root, @"scripts\TrafficWatch-Control.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("流量中心缺少控制脚本。", script);
        ProcessStartInfo info = new ProcessStartInfo(PowerShell);
        info.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + script + "\" -Action " + action;
        info.UseShellExecute = elevate; info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        if (elevate) info.Verb = "runas";
        using (Process process = Process.Start(info))
        {
            if (!process.WaitForExit(70000)) throw new TimeoutException("操作超过 70 秒仍未结束。请刷新状态后查看控制日志。");
            return process.ExitCode;
        }
    }

    internal static void ReopenTray()
    {
        string trayPath = Path.Combine(Root, "TrafficWatch-Tray.exe");
        if (!File.Exists(trayPath)) throw new FileNotFoundException("找不到托盘程序。", trayPath);
        using (Process signal = Process.Start(new ProcessStartInfo(trayPath, "--attach-suite --exit")
            { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden }))
        {
            if (!signal.WaitForExit(4000)) throw new TimeoutException("原托盘未响应，请先完全停止后重试。");
        }
        DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        while (HasProcess("TrafficWatch-Tray") && DateTime.UtcNow < deadline) Thread.Sleep(150);
        if (HasProcess("TrafficWatch-Tray")) throw new InvalidOperationException("原托盘没有退出。可在流量中心的更多控制中完全停止，再用桌面快捷方式打开。");
        EnsureTray();
    }

    internal static void EnsureTray()
    {
        if (HasProcess("TrafficWatch-Tray")) return;
        string trayPath = Path.Combine(Root, "TrafficWatch-Tray.exe");
        // Attach-only mode never starts the collectors. The ordinary user owns this tray.
        using (Process process = Process.Start(new ProcessStartInfo(trayPath, "--attach-suite --no-browser")
            { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root, WindowStyle = ProcessWindowStyle.Hidden })) { }
    }

    private static bool OverviewReady()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:43131/api/health");
            request.Proxy = null; request.Timeout = 500; request.ReadWriteTimeout = 500;
            request.AllowAutoRedirect = false; request.KeepAlive = false;
            using (WebResponse response = request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                char[] buffer = new char[8193]; int count = reader.ReadBlock(buffer, 0, buffer.Length);
                if (count > 8192) return false;
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(new string(buffer, 0, count));
                object app, readOnly;
                return data.TryGetValue("app", out app) && Convert.ToString(app) == "trafficwatch-overview"
                    && data.TryGetValue("readOnly", out readOnly) && Object.Equals(readOnly, true);
            }
        }
        catch { return false; }
    }

    internal static void OpenOverview(bool openBrowser = true)
    {
        using (Mutex mutex = new Mutex(false, @"Local\TrafficWatch-Overview-Launcher"))
        {
            bool owner;
            try { owner = mutex.WaitOne(6000); } catch (AbandonedMutexException) { owner = true; }
            if (!owner) throw new TimeoutException("简洁总览正在启动，请稍后重试。");
            try
            {
                if (!OverviewReady())
                {
                    string node = Path.Combine(Root, @"runtime\node.exe");
                    string script = Path.Combine(Root, @"src\overview-server.mjs");
                    if (!File.Exists(node) || !File.Exists(script)) throw new FileNotFoundException("简洁总览程序文件缺失，请重新安装。");
                    using (Process child = Process.Start(new ProcessStartInfo(node, "--disable-warning=ExperimentalWarning \"" + script + "\"")
                        { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root, WindowStyle = ProcessWindowStyle.Hidden })) { }
                    DateTime deadline = DateTime.UtcNow.AddSeconds(6);
                    while (!OverviewReady() && DateTime.UtcNow < deadline) Thread.Sleep(120);
                    if (!OverviewReady()) throw new InvalidOperationException("流量中心未能启动。请检查 43131 端口是否被占用。");
                }
            }
            finally { mutex.ReleaseMutex(); }
        }
        if (openBrowser) Process.Start(new ProcessStartInfo("http://127.0.0.1:43131/") { UseShellExecute = true });
    }

}

internal static class ControlEntry
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool command = args.Length > 0 && (args[0] == "--action" || args[0] == "--status" || args[0] == "--ensure-overview");
        try
        {
            using (Process self = Process.GetCurrentProcess()) if (self.SessionId == 0) return 4;
            if (args.Length == 0 || args.Length == 1 && args[0] == "--overview") { ControlBackend.OpenOverview(); return 0; }
            if (args.Length == 1 && args[0] == "--ensure-overview") { ControlBackend.OpenOverview(false); return 0; }
            if (args.Length == 1 && args[0] == "--status") {
                using (var output = new StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)))
                    output.WriteLine(new JavaScriptSerializer().Serialize(ControlBackend.ReadStatus()));
                return 0;
            }
            if (args.Length == 2 && args[0] == "--action") {
                if (args[1] == "ReopenTray") { ControlBackend.ReopenTray(); return 0; }
                int code = ControlBackend.RunAction(args[1], true);
                if (code == 0 && args[1] == "Start") ControlBackend.EnsureTray();
                return code;
            }
            return 2;
        }
        catch (Win32Exception error)
        {
            if (error.NativeErrorCode == 1223) return 3;
            if (!command) MessageBox.Show(error.Message, "流量中心", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        catch (Exception error)
        {
            if (!command) MessageBox.Show(error.Message, "流量中心", MessageBoxButtons.OK, MessageBoxIcon.Error);
            else Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
