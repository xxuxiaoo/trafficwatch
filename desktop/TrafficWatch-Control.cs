using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
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
    internal static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
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

    private enum OverviewState { Ready, Unavailable, UnexpectedResponse }

    private static OverviewState ProbeOverview(string url, out string detail)
    {
        detail = "HTTP 200";
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url + "api/health");
            request.Proxy = null; request.Timeout = 900; request.ReadWriteTimeout = 900;
            request.AllowAutoRedirect = false; request.KeepAlive = false;
            using (new System.Threading.Timer(_ => request.Abort(), null, 1200, Timeout.Infinite))
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                if (response.StatusCode != HttpStatusCode.OK)
                {
                    detail = "HTTP " + (int)response.StatusCode;
                    return OverviewState.UnexpectedResponse;
                }
                char[] buffer = new char[8193]; int count = reader.ReadBlock(buffer, 0, buffer.Length);
                if (count > 8192)
                {
                    detail = "健康响应过大";
                    return OverviewState.UnexpectedResponse;
                }
                var health = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(new string(buffer, 0, count));
                object app, storage, version, pid, singleCollector;
                if (health != null && health.TryGetValue("app", out app) && Object.Equals(app, "trafficwatch-overview")
                    && health.TryGetValue("storage", out storage) && Object.Equals(storage, "sqlite-wal")
                    && health.TryGetValue("version", out version) && !String.IsNullOrWhiteSpace(version as string)
                    && health.TryGetValue("collectorPid", out pid) && pid is int && (int)pid > 0
                    && health.TryGetValue("singleCollector", out singleCollector) && singleCollector == null)
                    return OverviewState.Ready;
                detail = "健康响应与已安装版 TrafficWatch 不匹配";
                return OverviewState.UnexpectedResponse;
            }
        }
        catch (WebException error)
        {
            using (var response = error.Response as HttpWebResponse)
            {
                detail = response == null ? error.Status.ToString() : "HTTP " + (int)response.StatusCode;
                return response == null ? OverviewState.Unavailable : OverviewState.UnexpectedResponse;
            }
        }
        catch (IOException error)
        {
            detail = error.GetBaseException().Message;
            return OverviewState.Unavailable;
        }
        catch (ArgumentException)
        {
            detail = "健康响应不是有效的 JSON 对象";
            return OverviewState.UnexpectedResponse;
        }
        catch (InvalidOperationException)
        {
            detail = "健康响应不是有效的 JSON 对象";
            return OverviewState.UnexpectedResponse;
        }
    }

    private static bool HasOverviewListener(int port)
    {
        foreach (IPEndPoint endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            if (endpoint.Port == port && (endpoint.Address.Equals(IPAddress.Loopback) || endpoint.Address.Equals(IPAddress.Any)
                || endpoint.Address.Equals(IPAddress.IPv6Any) || endpoint.Address.Equals(IPAddress.Loopback.MapToIPv6()))) return true;
        return false;
    }

    private static void WriteOverviewLog(string filename, string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(filename));
            File.AppendAllText(filename, DateTime.UtcNow.ToString("o") + " [launcher] " + message + Environment.NewLine);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Cannot write overview startup log: " + error.Message);
        }
    }

    private static void EnsureOverview(string url, int port, string log)
    {
        using (Mutex mutex = new Mutex(false, @"Local\TrafficWatch-Overview-Launcher-" + port))
        {
            bool owner;
            try { owner = mutex.WaitOne(20000); } catch (AbandonedMutexException) { owner = true; }
            if (!owner) throw new TimeoutException("已有请求正在打开流量中心，请稍后重试。日志：" + log);
            Process child = null;
            var timer = Stopwatch.StartNew();
            try
            {
                string detail = "尚未监听";
                do
                {
                    bool listening = HasOverviewListener(port);
                    if (listening)
                    {
                        var state = ProbeOverview(url, out detail);
                        if (state == OverviewState.Ready)
                        {
                            if (child != null) WriteOverviewLog(log, "ready port=" + port + " elapsedMs=" + timer.ElapsedMilliseconds);
                            return;
                        }
                        if (state == OverviewState.UnexpectedResponse)
                            throw new InvalidOperationException("端口 " + port + " 上的服务返回了意外响应（" + detail + "）。日志：" + log);
                    }
                    if (child != null && child.HasExited)
                        throw new InvalidOperationException("流量中心启动进程已退出（退出码 " + child.ExitCode + "）。日志：" + log);
                    if (child == null && !listening)
                    {
                        string node = Path.Combine(Root, @"runtime\node.exe");
                        string script = Path.Combine(Root, @"src\overview-server.mjs");
                        if (!File.Exists(node) || !File.Exists(script)) throw new FileNotFoundException("流量中心程序文件缺失，请重新安装。");
                        var info = new ProcessStartInfo(node, "--disable-warning=ExperimentalWarning \"" + script + "\"")
                            { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Root, WindowStyle = ProcessWindowStyle.Hidden };
                        info.EnvironmentVariables["TRAFFICWATCH_OVERVIEW_PORT"] = port.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        info.EnvironmentVariables["TRAFFICWATCH_OVERVIEW_LOG"] = log;
                        WriteOverviewLog(log, "starting viewer port=" + port);
                        child = Process.Start(info);
                    }
                    Thread.Sleep(100);
                } while (timer.ElapsedMilliseconds < 15000);
                throw new TimeoutException("流量中心在端口 " + port + " 上等候健康响应超时（" + detail + "）。日志：" + log);
            }
            finally
            {
                if (child != null) child.Dispose();
                mutex.ReleaseMutex();
            }
        }
    }

    internal static void OpenOverview(bool openBrowser = true)
    {
        string configuredPort = Environment.GetEnvironmentVariable("TRAFFICWATCH_OVERVIEW_PORT");
        int port = 43131;
        if (!String.IsNullOrEmpty(configuredPort) && (!Int32.TryParse(configuredPort, out port) || port < 1024 || port > 65535))
            throw new ArgumentException("流量中心端口须在 1024 到 65535 之间。");
        string url = "http://127.0.0.1:" + port + "/";
        string log = Environment.GetEnvironmentVariable("TRAFFICWATCH_OVERVIEW_LOG");
        if (String.IsNullOrWhiteSpace(log))
            log = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"TrafficWatch\logs\overview-launch.log");
        log = Path.GetFullPath(log);
        try
        {
            EnsureOverview(url, port, log);
            if (openBrowser && Environment.GetEnvironmentVariable("NETWATCH_TEST_SILENT") != "1")
                using (Process browser = Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })) { }
        }
        catch (Exception error)
        {
            WriteOverviewLog(log, "port=" + port + " " + error.Message);
            throw;
        }
    }

}

internal static class ControlEntry
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool command = Environment.GetEnvironmentVariable("NETWATCH_TEST_SILENT") == "1" ||
            args.Length > 0 && (args[0] == "--action" || args[0] == "--status" || args[0] == "--ensure-overview");
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
            else Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
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
