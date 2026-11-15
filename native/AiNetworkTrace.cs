using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Session;

// TraceEvent decodes kernel versions; only allowlisted socket metadata leaves this helper.
internal static class AiNetworkTrace {
    static readonly object Gate = new object();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    static readonly Dictionary<string, Dictionary<string, object>> Pending = new Dictionary<string, Dictionary<string, object>>();
    static readonly Dictionary<int, string> Names = new Dictionary<int, string>();
    static HashSet<string> Targets = new HashSet<string>();
    static TraceEventSession Session;
    static long Dropped, Total;
    static bool Stopping;
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static string ProcessName(int pid) {
        string name; if (Names.TryGetValue(pid, out name)) return name;
        name = "unknown"; try { using (Process p = Process.GetProcessById(pid)) name = p.ProcessName; } catch { }
        if (Names.Count > 2048) Names.Clear(); Names[pid] = name; return name;
    }
    static object Field(TraceEvent d, string name) { try { return d.PayloadByName(name); } catch { return null; } }
    static void OnEvent(TraceEvent d) {
        if (!d.TaskName.StartsWith("TcpIp", StringComparison.OrdinalIgnoreCase)) return;
        string source = Convert.ToString(Field(d, "saddr")), destination = Convert.ToString(Field(d, "daddr"));
        int sport, dport; if (!Int32.TryParse(Convert.ToString(Field(d, "sport")), out sport) || !Int32.TryParse(Convert.ToString(Field(d, "dport")), out dport)) return;
        int pid = d.ProcessID; object payloadPid = Field(d, "PID"); if (payloadPid != null) Int32.TryParse(Convert.ToString(payloadPid), out pid);
        string op = d.OpcodeName, name = ProcessName(pid);
        lock (Gate) {
            if (!Targets.Contains(source) && !Targets.Contains(destination) && !(sport == 443 || dport == 443) && sport != 7897 && dport != 7897) return;
            if (!Targets.Contains(source) && !Targets.Contains(destination) && !System.Text.RegularExpressions.Regex.IsMatch(name, "magpie|codex|claude|dsh|cc.?switch|mihomo|clash", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) return;
            string key = pid + "|" + source + "|" + sport + "|" + destination + "|" + dport + "|" + op;
            Dictionary<string, object> row;
            if (!Pending.TryGetValue(key, out row)) {
                if (Pending.Count >= 2048) { Dropped++; return; }
                row = new Dictionary<string, object> { {"at", new DateTimeOffset(d.TimeStamp.ToUniversalTime()).ToUnixTimeMilliseconds()}, {"pid",pid}, {"process",name}, {"source",source}, {"sourcePort",sport}, {"destination",destination}, {"destinationPort",dport}, {"operation",op}, {"count",0L}, {"bytes",0L} };
                Pending[key] = row;
            }
            row["count"] = (long)row["count"] + 1; long size; if (Int64.TryParse(Convert.ToString(Field(d,"size")),out size)) row["bytes"] = (long)row["bytes"] + Math.Max(0,size);
            Total++;
        }
    }
    static void Flush() {
        lock (Gate) {
            Emit(new { kind="trace", at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), events=new List<Dictionary<string,object>>(Pending.Values), eventsLost=Session == null ? 0 : Session.EventsLost, boundedDrops=Dropped, eventsSeen=Total });
            Pending.Clear();
        }
    }
    public static int Main() {
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        string sessionName="TrafficWatchDiag-"+Guid.NewGuid().ToString("N");
        try {
            using (var session = new TraceEventSession(sessionName)) {
                Session=session; session.StopOnDispose=true; session.BufferSizeMB=16;
                session.EnableKernelProvider(KernelTraceEventParser.Keywords.NetworkTCPIP);
                session.Source.Kernel.All += OnEvent;
                Emit(new {kind="ready",source="TraceEvent",version="2.0.77",session=sessionName});
                Thread input = new Thread(delegate() {
                    try { string line; while ((line=Console.ReadLine())!=null) {
                        if (line=="stop") break;
                        try { string[] ips=Json.Deserialize<string[]>(line); lock(Gate) Targets=new HashSet<string>(ips); } catch { }
                    }} finally { Stopping=true;session.Source.StopProcessing(); }
                }); input.IsBackground=true; input.Start();
                using (var timer=new Timer(delegate { try { if (!Stopping) Flush(); } catch { Stopping=true;session.Source.StopProcessing(); } },null,2000,2000)) session.Source.Process();
                Flush();
            }
            return 0;
        } catch (Exception e) { Emit(new {kind="error",code="trace_unavailable",type=e.GetType().Name,hresult=e.HResult,selfTestDetail=Environment.GetEnvironmentVariable("TRAFFICWATCH_DIAGNOSTIC_SELFTEST")=="1"?e.Message:null});return 1; }
        finally { Session=null; }
    }
}
