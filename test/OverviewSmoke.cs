using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class NetwatchOverviewSmoke
{
    private static string output;

    private static async Task<bool> IsTrue(WebView2 browser, string expression)
    {
        try
        {
            return browser.CoreWebView2 != null && await browser.CoreWebView2.ExecuteScriptAsync(expression) == "true";
        }
        catch { return false; }
    }

    private static async Task<string> PageState(WebView2 browser)
    {
        try
        {
            if (browser.CoreWebView2 == null) return "WebView2 core is unavailable.";
            return await browser.CoreWebView2.ExecuteScriptAsync(
                "JSON.stringify({url:location.href,ready:document.readyState,machine:document.querySelector('#overviewMachine')?.textContent,proxy:document.querySelector('#overviewProxy')?.textContent,notice:document.querySelector('#globalNotice')?.textContent,client:document.querySelector('#proxyClientFilter')?.value,airport:document.querySelector('#proxyAirportFilter')?.value,airportRows:document.querySelector('#airportUsageRows')?.innerText})"
            );
        }
        catch (Exception error) { return error.ToString(); }
    }

    private static async Task WaitFor(WebView2 browser, string expression, int milliseconds, string failure)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(milliseconds);
        while (DateTime.UtcNow < deadline)
        {
            if (await IsTrue(browser, expression)) return;
            await Task.Delay(150);
        }
        throw new Exception(failure + " Page state: " + await PageState(browser));
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args == null || args.Length < 4) throw new ArgumentException("Expected URL, profile, report, and screenshot paths.");
            output = args[2];
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Form window = new Form { Text = "TrafficWatch overview smoke", StartPosition = FormStartPosition.CenterScreen, ClientSize = new System.Drawing.Size(1280, 860), ShowInTaskbar = false };
            WebView2 browser = new WebView2 { Dock = DockStyle.Fill };
            window.Controls.Add(browser);
            window.Shown += async delegate
            {
                try
                {
                    File.WriteAllText(output, "stage:create-environment");
                    Directory.CreateDirectory(args[1]);
                    CoreWebView2EnvironmentOptions environmentOptions = new CoreWebView2EnvironmentOptions();
                    environmentOptions.AdditionalBrowserArguments = "--disable-gpu --disable-gpu-compositing";
                    Task<CoreWebView2Environment> environmentTask = CoreWebView2Environment.CreateAsync(null, args[1], environmentOptions);
                    if (await Task.WhenAny(environmentTask, Task.Delay(20000)) != environmentTask) throw new TimeoutException("WebView2 environment creation timed out.");
                    CoreWebView2Environment environment = await environmentTask;
                    File.WriteAllText(output, "stage:ensure-core");
                    Task ensureTask = browser.EnsureCoreWebView2Async(environment);
                    if (await Task.WhenAny(ensureTask, Task.Delay(20000)) != ensureTask) throw new TimeoutException("WebView2 core initialization timed out.");
                    await ensureTask;
                    browser.CoreWebView2.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs error)
                    {
                        File.AppendAllText(output, "\r\nWebView2 process failed: " + error.ProcessFailedKind + " / " + error.Reason);
                    };
                    browser.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs navigation)
                    {
                        File.AppendAllText(output, "\r\nNavigation completed: " + navigation.IsSuccess + " / " + navigation.WebErrorStatus);
                    };
                    browser.CoreWebView2.Navigate(args[0]);
                    File.WriteAllText(output, "stage:overview");
                    await WaitFor(browser,
                        "Boolean(document.querySelector('#overviewMachine') && document.querySelector('#overviewMachine').textContent.trim() !== '\u2014' && document.querySelector('#overviewProxy').textContent.trim() !== '\u2014')",
                        30000, "Unified overview totals did not render.");
                    string language = args.Length > 4 ? args[4] : "zh-CN";
                    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#language').value='" + language + "'; document.querySelector('#language').dispatchEvent(new Event('change'));");
                    await WaitFor(browser, "document.documentElement.lang === '" + language + "'", 5000, "Requested dashboard language did not apply.");
                    await browser.CoreWebView2.ExecuteScriptAsync("window.__smokeTotals=[document.querySelector('#overviewMachine').textContent,document.querySelector('#overviewProxy').textContent]");
                    using (FileStream image = File.Create(Path.ChangeExtension(args[3], ".overview.png")))
                        await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);

                    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-view-button=ladder]').click()");
                    await WaitFor(browser,
                        "!document.querySelector('[data-view=ladder]').hidden && document.querySelector('#airportUsageRows').textContent.includes('TAG') && document.querySelector('#airportUsageRows').textContent.includes('Clash Verge') && document.querySelector('#airportUsageRows').textContent.includes('FlClash')",
                        15000, "Client-specific airport totals did not render.");

                    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('.airport-manager').open=true");
                    await WaitFor(browser,
                        "document.querySelector('#airportNodeChoices').textContent.includes('Clash Verge') && document.querySelector('#airportNodeChoices').textContent.includes('FlClash') && (document.querySelector('#airportNodeChoices').textContent.match(/TAG-HK-1/g)||[]).length >= 2",
                        15000, "Lazy node inventory did not distinguish identical node names by client.");

                    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#proxyClientFilter').value='flclash'; document.querySelector('#proxyClientFilter').dispatchEvent(new Event('change'))");
                    await WaitFor(browser,
                        "document.querySelector('#airportUsageRows').textContent.includes('FlClash') && !document.querySelector('#airportUsageRows').textContent.includes('Clash Verge') && !document.querySelector('#airportUsageRows').textContent.includes('TAG')",
                        30000, "FlClash filter included Clash Verge airport usage.");

                    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('#proxyClientFilter').value='verge'; document.querySelector('#proxyClientFilter').dispatchEvent(new Event('change')); document.querySelector('#proxyAirportFilter').value='tag'; document.querySelector('#proxyAirportFilter').dispatchEvent(new Event('change'))");
                    await WaitFor(browser,
                        "document.querySelector('#airportUsageRows').textContent.includes('TAG') && document.querySelector('#airportUsageRows').textContent.includes('Clash Verge') && !document.querySelector('#airportUsageRows').textContent.includes('FlClash')",
                        15000, "TAG filter did not remain scoped to Clash Verge.");
                    using (FileStream image = File.Create(args[3]))
                        await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, image);

                    await browser.CoreWebView2.ExecuteScriptAsync("document.querySelector('[data-view-button=overview]').click()");
                    if (!await IsTrue(browser, "JSON.stringify(window.__smokeTotals) === JSON.stringify([document.querySelector('#overviewMachine').textContent,document.querySelector('#overviewProxy').textContent])"))
                        throw new Exception("Ladder filters changed the global overview totals.");
                    File.WriteAllText(output, "{\"status\":\"passed\",\"checks\":[\"unified overview totals\",\"client-specific airport totals\",\"same-name node membership distinguished by client\",\"lazy node inventory\",\"client and TAG filters stay local\"]}");
                    Environment.ExitCode = 0;
                }
                catch (Exception error)
                {
                    File.AppendAllText(output, "\r\nOverview GUI smoke failed: " + error.ToString());
                    Environment.ExitCode = 1;
                }
                finally { window.Dispose(); Application.ExitThread(); }
            };
            Application.Run(window);
            return Environment.ExitCode;
        }
        catch (Exception error)
        {
            if (!String.IsNullOrEmpty(output)) File.WriteAllText(output, "Overview GUI smoke failed: " + error.ToString());
            return 1;
        }
    }
}
