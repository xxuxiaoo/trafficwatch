using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("TrafficWatch 流量采集控制台")]
[assembly: AssemblyDescription("Start, stop and inspect the local TrafficWatch collectors and tray")]
[assembly: AssemblyProduct("TrafficWatch Control")]
[assembly: AssemblyVersion("1.0.0.0")]

internal sealed class ControlSnapshot
{
    public string Machine = "读取中", Clash = "读取中", Supervisor = "读取中", Tray = "读取中", Capture = "读取中", Startup = "读取中";
    public string Headline = "正在检查实际状态…";
    public bool Running, Pending;
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
        if (action != "Start" && action != "Stop" && action != "EnableStartup" && action != "DisableStartup")
            throw new ArgumentException("Unsupported control action.");
        string script = Path.Combine(Root, @"scripts\TrafficWatch-Control.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("控制脚本缺失，请重新安装控制台。", script);
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
        if (HasProcess("TrafficWatch-Tray")) throw new InvalidOperationException("原托盘没有退出。可先点击“完全停止全部”，再重新打开托盘。");
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

    internal static void OpenOverview()
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
                    if (!OverviewReady()) throw new InvalidOperationException("简洁总览未能启动。请检查 43131 端口是否被占用；可从控制台完全停止后重试。");
                }
            }
            finally { mutex.ReleaseMutex(); }
        }
        Process.Start(new ProcessStartInfo("http://127.0.0.1:43131/") { UseShellExecute = true });
    }
}

internal sealed class ControlWindow : Form
{
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    private readonly Label headline = new Label(), message = new Label(), lastUpdate = new Label();
    private readonly Dictionary<string, Label> values = new Dictionary<string, Label>();
    private readonly List<Button> actionButtons = new List<Button>();
    private readonly System.Windows.Forms.Timer refreshTimer = new System.Windows.Forms.Timer();
    private bool reading, busy;
    private readonly Color mint = Color.FromArgb(27, 114, 73), muted = Color.FromArgb(83, 94, 103);

    internal ControlWindow()
    {
        Text = "流量采集控制台";
        Name = "TrafficWatchControl";
        Font = new Font("Microsoft YaHei UI", 9F);
        BackColor = Color.FromArgb(245, 247, 249);
        ClientSize = new Size(760, 650);
        MinimumSize = new Size(740, 680);
        AutoScaleMode = AutoScaleMode.Dpi;
        StartPosition = FormStartPosition.CenterScreen;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        TableLayoutPanel layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 8, Padding = new Padding(24, 20, 24, 16) };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 41));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 35));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 200));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 67));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 61));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 68));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26));
        Controls.Add(layout);
        Label title = MakeLabel("流量采集控制台", 20F, Color.FromArgb(27, 38, 49));
        title.Font = new Font(Font.FontFamily, 20F, FontStyle.Bold);
        layout.Controls.Add(title, 0, 0);
        headline.Text = "正在检查实际状态…"; headline.Dock = DockStyle.Fill; headline.ForeColor = mint;
        headline.Font = new Font(Font.FontFamily, 10F, FontStyle.Bold); headline.TextAlign = ContentAlignment.MiddleLeft;
        layout.Controls.Add(headline, 0, 1);

        TableLayoutPanel status = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Color.White, ColumnCount = 2, RowCount = 6, Padding = new Padding(14, 7, 10, 7), Margin = new Padding(0, 0, 0, 10) };
        status.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 125));
        status.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        string[,] rows = { { "machine", "本机流量采集" }, { "clash", "Clash 流量采集" }, { "supervisor", "后台守护任务" }, { "capture", "ETW 采集助手" }, { "tray", "托盘入口" }, { "startup", "自动启动" } };
        for (int row = 0; row < 6; row++)
        {
            status.RowStyles.Add(new RowStyle(SizeType.Percent, 100F / 6));
            Label label = MakeLabel(rows[row, 1], 9F, muted); label.TextAlign = ContentAlignment.MiddleLeft;
            Label value = MakeLabel("读取中", 9F, Color.FromArgb(32, 44, 55)); value.TextAlign = ContentAlignment.MiddleLeft;
            value.Name = rows[row, 0] + "Status";
            values.Add(rows[row, 0], value);
            status.Controls.Add(label, 0, row); status.Controls.Add(value, 1, row);
        }
        layout.Controls.Add(status, 0, 2);

        TableLayoutPanel primary = Row(3);
        primary.Controls.Add(ActionButton("startAll", "启动全部采集", mint, Color.White, async delegate { await PerformAction("Start"); }), 0, 0);
        primary.Controls.Add(ActionButton("stopAll", "完全停止全部", Color.FromArgb(177, 57, 53), Color.White, async delegate { await PerformAction("Stop"); }), 1, 0);
        primary.Controls.Add(ActionButton("reopenTray", "重新打开托盘", Color.White, Color.FromArgb(32, 44, 55), async delegate { await PerformTray(); }), 2, 0);
        layout.Controls.Add(primary, 0, 3);

        TableLayoutPanel secondary = Row(2);
        secondary.Controls.Add(ActionButton("disableStartup", "停止并停用开机自启", Color.White, Color.FromArgb(100, 46, 42), async delegate { await PerformAction("DisableStartup"); }), 0, 0);
        secondary.Controls.Add(ActionButton("enableStartup", "开启开机自启", Color.White, Color.FromArgb(32, 44, 55), async delegate { await PerformAction("EnableStartup"); }), 1, 0);
        layout.Controls.Add(secondary, 0, 4);

        Label help = MakeLabel("完全停止：停止两路采集、守护、总览和托盘；下次开机仍按原设置启动。\r\n停止并停用：同时关闭开机采集和登录托盘；需手动恢复。\r\n重新打开托盘、查看简洁总览均不会启动采集。关闭本窗口不会改变采集状态。", 9F, muted);
        layout.Controls.Add(help, 0, 5);
        message.Dock = DockStyle.Fill; message.Text = "操作不依赖 Magpie、Clash 或聊天连接。系统级操作会请求 Windows 管理员授权。";
        message.ForeColor = muted; message.Padding = new Padding(0, 8, 0, 4);
        layout.Controls.Add(message, 0, 6);

        FlowLayoutPanel footer = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0) };
        AddLink(footer, "流量中心", async delegate { await PerformOverview(); });
        AddLink(footer, "旧版全机", delegate { Open("http://127.0.0.1:43128/?legacy=1"); });
        AddLink(footer, "旧版 Clash", delegate { Open("http://127.0.0.1:43130/?legacy=1"); });
        AddLink(footer, "数据目录", OpenData);
        AddLink(footer, "控制日志", delegate { Open(Path.Combine(ControlBackend.Root, @"logs\control.log")); });
        AddLink(footer, "刷新状态", async delegate { await RefreshStatus(); });
        lastUpdate.AutoSize = true; lastUpdate.ForeColor = muted; lastUpdate.Margin = new Padding(10, 3, 0, 0);
        footer.Controls.Add(lastUpdate);
        layout.Controls.Add(footer, 0, 7);
        refreshTimer.Interval = 4000;
        refreshTimer.Tick += async delegate { if (!busy) await RefreshStatus(); };
        Shown += async delegate { await RefreshStatus(); refreshTimer.Start(); };
        FormClosed += delegate { refreshTimer.Stop(); refreshTimer.Dispose(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (busy) { e.Cancel = true; message.Text = "正在执行操作，请等待完成后关闭窗口。"; }
        };
    }

    private Label MakeLabel(string text, float size, Color color)
    {
        return new Label { Text = text, Dock = DockStyle.Fill, AutoSize = false, ForeColor = color, Font = new Font(Font.FontFamily, size), Margin = new Padding(0) };
    }
    private TableLayoutPanel Row(int count)
    {
        var panel = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = count, RowCount = 1, Margin = new Padding(0, 3, 0, 8) };
        for (int index = 0; index < count; index++) panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F / count));
        return panel;
    }
    private Button ActionButton(string name, string text, Color background, Color foreground, EventHandler click)
    {
        var button = new Button { Name = name, Text = text, Dock = DockStyle.Fill, FlatStyle = FlatStyle.Flat, BackColor = background, ForeColor = foreground, Cursor = Cursors.Hand, Margin = new Padding(0, 0, 8, 0), UseVisualStyleBackColor = false, AccessibleName = text };
        button.FlatAppearance.BorderColor = Color.FromArgb(216, 222, 228);
        button.Click += click; actionButtons.Add(button); return button;
    }
    private void AddLink(FlowLayoutPanel panel, string text, EventHandler click)
    {
        LinkLabel link = new LinkLabel { Text = text, AutoSize = true, LinkColor = mint, Margin = new Padding(0, 3, 13, 0) };
        link.Click += click; panel.Controls.Add(link);
    }
    private void Open(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Exception error) { message.Text = error.Message; }
    }
    private void OpenData(object sender, EventArgs e)
    {
        try
        {
            var settings = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(ControlBackend.Root, "suite-settings.json")));
            Open(Convert.ToString(settings["DataRoot"]));
        }
        catch (Exception error) { message.Text = error.Message; }
    }
    internal async Task RefreshStatus()
    {
        if (reading) return;
        reading = true;
        try
        {
            ControlSnapshot snapshot = await Task.Run(() => ControlBackend.ReadStatus());
            if (IsDisposed) return;
            headline.Text = snapshot.Headline;
            headline.ForeColor = snapshot.Running || snapshot.Pending ? mint : muted;
            values["machine"].Text = snapshot.Machine; values["clash"].Text = snapshot.Clash;
            values["supervisor"].Text = snapshot.Supervisor; values["capture"].Text = snapshot.Capture;
            values["tray"].Text = snapshot.Tray; values["startup"].Text = snapshot.Startup;
            lastUpdate.Text = "更新 " + DateTime.Now.ToString("HH:mm:ss");
        }
        catch (Exception error) { if (!IsDisposed) message.Text = "状态读取失败：" + error.Message; }
        finally { reading = false; }
    }
    private void SetBusy(bool value, string text)
    {
        busy = value;
        foreach (Button button in actionButtons) button.Enabled = !value;
        message.Text = text;
        message.ForeColor = value ? mint : muted;
        UseWaitCursor = value;
    }
    private async Task PerformAction(string action)
    {
        if (busy) return;
        string progress = action == "Start" ? "正在启动两路采集服务…" : action == "EnableStartup" ? "正在开启开机自启…" : "正在停止守护、两路采集和托盘，必要时清理残留组件…";
        SetBusy(true, progress);
        try
        {
            int exitCode = await Task.Run(() => ControlBackend.RunAction(action, true));
            if (exitCode != 0) throw new InvalidOperationException("操作未完成（退出码 " + exitCode + "）。请点击“控制日志”查看原因，然后刷新实际状态。");
            if (action == "Start")
            {
                string trayFailure = null;
                try { await Task.Run(() => ControlBackend.EnsureTray()); }
                catch (Exception trayError) { trayFailure = trayError.Message; }
                if (trayFailure != null) { SetBusy(false, "采集服务已启动，但托盘未打开：" + trayFailure); await RefreshStatus(); return; }
            }
            string result = action == "Start" ? "两路采集服务和托盘已启动；Clash 尚未运行时会显示等待接口。开机自启偏好保持原设置。"
                : action == "Stop" ? "已完全停止：两路采集、守护任务、采集助手、总览和托盘均已退出。开机自启设置保持原样。"
                : action == "DisableStartup" ? "已停止全部组件，并关闭开机采集和登录托盘。手动启动一次仍可使用。"
                : "已开启开机采集和登录托盘；如需现在运行，请点击“启动全部采集”。";
            SetBusy(false, result);
        }
        catch (Win32Exception error)
        {
            SetBusy(false, error.NativeErrorCode == 1223 ? "你取消了 Windows 管理员授权，本次操作没有执行。" : error.Message);
        }
        catch (Exception error) { SetBusy(false, error.Message); }
        await RefreshStatus();
    }
    private async Task PerformTray()
    {
        if (busy) return;
        SetBusy(true, "正在重新打开托盘，不会启动采集…");
        try
        {
            await Task.Run(() => ControlBackend.ReopenTray());
            SetBusy(false, "托盘已重新打开。若未看到图标，请展开任务栏的隐藏图标区。采集状态没有改变。");
        }
        catch (Exception error) { SetBusy(false, error.Message); }
        await RefreshStatus();
    }
    private async Task PerformOverview()
    {
        if (busy) return;
        SetBusy(true, "正在打开简洁总览，只读取历史，不会启动采集…");
        try { await Task.Run(() => ControlBackend.OpenOverview()); SetBusy(false, "已打开流量中心。左侧可切换总览、本机应用、梯子和 Harness；点击高峰可定位应用与目标。"); }
        catch (Exception error) { SetBusy(false, error.Message); }
    }
    internal void SavePreview(string file)
    {
        StartPosition = FormStartPosition.Manual; Location = new Point(-2000, -2000); ShowInTaskbar = false;
        Show();
        ControlSnapshot snapshot = ControlBackend.ReadStatus();
        headline.Text = snapshot.Headline;
        values["machine"].Text = snapshot.Machine; values["clash"].Text = snapshot.Clash;
        values["supervisor"].Text = snapshot.Supervisor; values["capture"].Text = snapshot.Capture;
        values["tray"].Text = snapshot.Tray; values["startup"].Text = snapshot.Startup;
        Application.DoEvents();
        using (Bitmap image = new Bitmap(Width, Height)) { DrawToBitmap(image, new Rectangle(Point.Empty, Size)); image.Save(file); }
        Close();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try
        {
            if (args.Length == 1 && args[0] == "--overview") { ControlBackend.OpenOverview(); return 0; }
            if (args.Length == 2 && args[0] == "--snapshot")
            {
                using (ControlWindow window = new ControlWindow()) window.SavePreview(Path.GetFullPath(args[1]));
                return 0;
            }
            if (args.Length != 0) return 2;
            using (Mutex mutex = new Mutex(false, @"Local\TrafficWatch-Control-Panel"))
            {
                bool owner;
                try { owner = mutex.WaitOne(0); } catch (AbandonedMutexException) { owner = true; }
                if (!owner)
                {
                    foreach (Process process in Process.GetProcessesByName("TrafficWatch-Control"))
                    {
                        using (process)
                        {
                            if (process.Id == Process.GetCurrentProcess().Id || process.MainWindowHandle == IntPtr.Zero) continue;
                            ShowWindow(process.MainWindowHandle, 9); SetForegroundWindow(process.MainWindowHandle); break;
                        }
                    }
                    return 0;
                }
                try { using (ControlWindow window = new ControlWindow()) Application.Run(window); }
                finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "流量采集控制台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
