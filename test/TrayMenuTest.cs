using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Windows.Forms;

internal static class TrayMenuTest
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1) throw new ArgumentException("Expected the packaged tray executable path.");
            var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
            var trayType = assembly.GetType("NetwatchTray", true);
            var optionsType = assembly.GetType("TrayOptions", true);
            var fields = BindingFlags.Instance | BindingFlags.NonPublic;
            // Exercise the actual menu component without registering a tray or launching a collector.
            var tray = FormatterServices.GetUninitializedObject(trayType);
            var options = Activator.CreateInstance(optionsType, true);
            optionsType.GetField("AttachSuite", fields).SetValue(options, true);
            trayType.GetField("options", fields).SetValue(tray, options);
            trayType.GetField("chinese", fields).SetValue(tray, true);
            using (var menu = (ContextMenuStrip)trayType.GetMethod("BuildMenu", fields).Invoke(tray, null))
            {
                var items = menu.Items.OfType<ToolStripMenuItem>().ToArray();
                string[] expected = { "正在启动…", "打开流量中心", "启动采集", "暂停采集", "退出托盘（后台继续记录）" };
                if (!items.Select(item => item.Text).SequenceEqual(expected))
                    throw new InvalidOperationException("Tray items: " + String.Join(" | ", items.Select(item => item.Text)));
                if (items.Count(item => item.Enabled) != 2 || items.Any(item => item.HasDropDownItems))
                    throw new InvalidOperationException("Unexpected command state or submenu.");
            }
            Console.WriteLine("Packaged WinForms tray menu: 1 status, 4 actions, 0 submenus.");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
