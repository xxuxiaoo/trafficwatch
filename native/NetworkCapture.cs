using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Windows x64 ETW consumer. No packet payloads, DNS requests, drivers or service.
// A private SystemTraceProvider session avoids taking over NT Kernel Logger.
internal static class NetworkCapture
{
    static readonly Guid Tcp = new Guid("9a280ac0-c8e0-11d1-84e2-00c04fb998a2");
    static readonly Guid Udp = new Guid("bf3a50c5-a9c9-4988-a005-2df0b7c80f80");
    static readonly object Gate = new object();
    static readonly Dictionary<string, Flow> Rows = new Dictionary<string, Flow>();
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
    static readonly string Generation = Guid.NewGuid().ToString("N");
    static ulong session, consumer = UInt64.MaxValue;
    static IntPtr properties, logfile, logger;
    static string sessionName;
    static EventCallback eventCallback;
    static volatile bool stopping;
    static long sequence, dropped, malformed;
    static long lastWindow = Now();
    static uint traceResult;
    sealed class Identity : IDisposable { public Process process; public string name; public long born; public void Dispose() { process.Dispose(); } }
    static readonly Dictionary<int, Identity> Processes = new Dictionary<int, Identity>();

    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void EventCallback(IntPtr record);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint StartTraceW(out ulong handle, string name, IntPtr properties);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint ControlTraceW(ulong handle, string name, IntPtr properties, uint control);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern ulong OpenTraceW(IntPtr logfile);
    [DllImport("advapi32.dll")] static extern uint ProcessTrace([In] ulong[] handles, uint count, IntPtr start, IntPtr end);
    [DllImport("advapi32.dll")] static extern uint CloseTrace(ulong handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out long luid);
    [StructLayout(LayoutKind.Sequential,Pack=4)] struct TokenPrivilege { public uint count; public long luid; public uint attributes; }
    [DllImport("advapi32.dll",SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TokenPrivilege state,uint length,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    internal sealed class Flow
    {
        public string id, start, network, sourceIP, destinationIP, process;
        public int sourcePort, destinationPort, processId;
        public long processBorn, upload, download;
    }
    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static IntPtr Zero(int size) { var p=Marshal.AllocHGlobal(size); Marshal.Copy(new byte[size],0,p,size); return p; }
    static void Put(IntPtr p,int offset,int value) { Marshal.WriteInt32(p,offset,value); }
    static string Address(byte[] data,int offset,int count) { var bytes=new byte[count]; Array.Copy(data,offset,bytes,0,count); return new IPAddress(bytes).ToString(); }
    static int Port(byte[] data,int offset) { return data[offset]*256+data[offset+1]; }

    // PID is read from event payload, not EVENT_HEADER.ProcessId: receive events
    // can run on a system worker thread. Versions 1+ share this prefix.
    internal static Flow Decode(Guid provider, byte opcode, byte version, byte[] data)
    {
        if ((provider!=Tcp && provider!=Udp) || version<1) return null;
        bool send=opcode==10 || opcode==26, receive=opcode==11 || opcode==27;
        if (!send && !receive) return null; // Do not count retransmit or TCP copy twice.
        bool v6=opcode>=26;
        if (data.Length < (v6?44:20)) throw new InvalidDataException("Truncated network event");
        int pid=BitConverter.ToInt32(data,0);
        uint size=BitConverter.ToUInt32(data,4);
        if (pid<=0 || size==0) return null;
        int addressSize=v6?16:4, sourceOffset=v6?24:12, portOffset=v6?40:16;
        string destination=Address(data,8,addressSize), source=Address(data,sourceOffset,addressSize);
        // TCP ETW keeps its local/remote connection tuple on receive. UDP uses
        // packet source/destination addresses and needs reversing on receive.
        bool reverse=receive && provider==Udp;
        return new Flow {
            network=provider==Tcp?"tcp":"udp", processId=pid,
            sourceIP=reverse?destination:source, destinationIP=reverse?source:destination,
            sourcePort=Port(data,portOffset+(reverse?0:2)), destinationPort=Port(data,portOffset+(reverse?2:0)),
            upload=send?size:0, download=receive?size:0
        };
    }
    static bool IsDiscoveryPort(int port) { return port==5353 || port==1900 || port==5355 || port==137 || port==138; }
    static bool IsKnownLocalPort(int port) { return port==43128 || port==43130 || port==43131 || port==43132 || port==3425 || port==7890 || port==7897 || port==10808 || port==10809; }
    static string NormalizeIp(string ip) {
        if (string.IsNullOrEmpty(ip)) return "";
        string lower=ip.ToLowerInvariant();
        return lower.StartsWith("::ffff:")?lower.Substring(7):lower;
    }
    static bool IsLoopbackIp(string ip) { string v=NormalizeIp(ip); return v=="::1" || v.StartsWith("127."); }
    static bool IsLocalOrMulticastIp(string ip) {
        string v=NormalizeIp(ip);
        if (string.IsNullOrEmpty(v)) return false;
        if (IsLoopbackIp(v) || v=="255.255.255.255" || v=="0.0.0.0" || v=="::") return true;
        if (v.IndexOf('.')>=0) {
            var p=v.Split('.');
            int a,b;
            if (p.Length!=4 || !Int32.TryParse(p[0],out a) || !Int32.TryParse(p[1],out b)) return false;
            return a==10 || (a==172 && b>=16 && b<=31) || (a==192 && b==168) || (a==169 && b==254) || (a>=224 && a<=239) || (a==100 && b>=64 && b<=127);
        }
        return v.StartsWith("fe80:") || v.StartsWith("fc") || v.StartsWith("fd") || v.StartsWith("ff");
    }
    static string DiscoveryCanonicalIp(int port, string ip) {
        bool v6=!string.IsNullOrEmpty(ip) && ip.IndexOf(':')>=0 && !ip.ToLowerInvariant().StartsWith("::ffff:");
        if (port==5353) return v6?"ff02::fb":"224.0.0.251";
        if (port==1900) return v6?"ff02::c":"239.255.255.250";
        if (port==5355) return v6?"ff02::1:3":"224.0.0.252";
        return v6?"ff02::1":"255.255.255.255";
    }
    internal static void AssignFlowId(Flow flow, string gen) {
        string prefix=gen+":"+flow.processId+":"+flow.processBorn;
        if (flow.network=="udp") {
            int dp=IsDiscoveryPort(flow.sourcePort)?flow.sourcePort:(IsDiscoveryPort(flow.destinationPort)?flow.destinationPort:0);
            if (dp>0 && IsLocalOrMulticastIp(flow.destinationIP)) {
                flow.sourcePort=dp; flow.destinationPort=dp; flow.destinationIP=DiscoveryCanonicalIp(dp,flow.destinationIP);
                flow.id=prefix+":udp:discovery:"+dp;
                return;
            }
        }
        if (IsLoopbackIp(flow.sourceIP) && IsLoopbackIp(flow.destinationIP)) {
            string dst=NormalizeIp(flow.destinationIP), src=NormalizeIp(flow.sourceIP);
            if (IsKnownLocalPort(flow.destinationPort)) {
                flow.sourcePort=0; flow.destinationIP=dst;
                flow.id=prefix+":"+flow.network+":loopback:"+dst+":"+flow.destinationPort;
                return;
            }
            if (IsKnownLocalPort(flow.sourcePort)) {
                flow.destinationPort=0; flow.destinationIP=dst;
                flow.id=prefix+":"+flow.network+":loopback-srv:"+src+":"+flow.sourcePort;
                return;
            }
            flow.sourcePort=0; flow.destinationPort=0; flow.destinationIP=dst;
            flow.id=prefix+":"+flow.network+":loopback:"+dst;
            return;
        }
        flow.id=prefix+":"+flow.network+":"+flow.sourceIP+":"+flow.sourcePort+":"+flow.destinationIP+":"+flow.destinationPort;
    }

    static void OnEvent(IntPtr record)
    {
        try {
            Guid provider=(Guid)Marshal.PtrToStructure(IntPtr.Add(record,24),typeof(Guid));
            if(provider!=Tcp && provider!=Udp) return;
            byte opcode=Marshal.ReadByte(record,45), version=Marshal.ReadByte(record,42);
            if(opcode!=10 && opcode!=11 && opcode!=26 && opcode!=27) return;
            ushort length=unchecked((ushort)Marshal.ReadInt16(record,86));
            if(length>256) { Interlocked.Increment(ref malformed); return; }
            var data=new byte[length]; Marshal.Copy(Marshal.ReadIntPtr(record,96),data,0,length);
            Flow flow=Decode(provider,opcode,version,data);
            if(flow==null) { if(version<1) Interlocked.Increment(ref malformed); return; }
            // Only process name and creation time are read; never command lines.
            try {
                Identity identity;
                if(Processes.TryGetValue(flow.processId,out identity) && identity.process.HasExited) { identity.Dispose(); Processes.Remove(flow.processId); identity=null; }
                if(identity==null) {
                    var p=Process.GetProcessById(flow.processId);
                    try { identity=new Identity { process=p,name=p.ProcessName+".exe",born=new DateTimeOffset(p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() }; }
                    catch { p.Dispose(); throw; }
                    if(Processes.Count>=4096) { foreach(var item in Processes.Values) item.Dispose(); Processes.Clear(); }
                    Processes[flow.processId]=identity;
                }
                long eventAt=new DateTimeOffset(DateTime.FromFileTimeUtc(Marshal.ReadInt64(record,16))).ToUnixTimeMilliseconds();
                if(identity.born>eventAt+1) throw new InvalidDataException("PID was reused after event");
                flow.process=identity.name; flow.processBorn=identity.born;
            } catch { flow.process=""; flow.processBorn=0; }
            AssignFlowId(flow, Generation);
            lock(Gate) {
                Flow row;
                if(Rows.TryGetValue(flow.id,out row)) { row.upload+=flow.upload; row.download+=flow.download; }
                else if(Rows.Count<8192) { flow.start=DateTime.UtcNow.ToString("o"); Rows.Add(flow.id,flow); }
                else dropped++;
            }
        } catch { Interlocked.Increment(ref malformed); }
    }
    static uint Start()
    {
        if(IntPtr.Size!=8) return 50;
        IntPtr token;
        if(OpenProcessToken(Process.GetCurrentProcess().Handle,0x28,out token)) {
            try { long luid; if(LookupPrivilegeValue(null,"SeSystemProfilePrivilege",out luid)) {
                var privilege=new TokenPrivilege { count=1,luid=luid,attributes=2 };
                AdjustTokenPrivileges(token,false,ref privilege,0,IntPtr.Zero,IntPtr.Zero);
            }} finally { CloseHandle(token); }
        }
        sessionName="CodexNetwatch-"+Generation;
        // EVENT_TRACE_PROPERTIES, x64 SDK layout (120 bytes + logger name).
        properties=Zero(120+1024);
        Put(properties,0,120+1024);
        Marshal.StructureToPtr(Guid.NewGuid(),IntPtr.Add(properties,24),false);
        Put(properties,40,1); Put(properties,44,0x20000);
        Put(properties,48,64); Put(properties,52,4); Put(properties,56,32);
        Put(properties,64,0x02000100); // SYSTEM_LOGGER_MODE | REAL_TIME_MODE
        Put(properties,68,1); Put(properties,72,0x00010000); // NETWORK_TCPIP only
        Put(properties,116,120);
        uint result=StartTraceW(out session,sessionName,properties);
        if(result!=0) { session=0; return result; }
        // EVENT_TRACE_LOGFILEW, x64 SDK layout, with EVENT_RECORD callback.
        logfile=Zero(448); logger=Marshal.StringToHGlobalUni(sessionName);
        Marshal.WriteIntPtr(logfile,8,logger); Put(logfile,28,0x10000100);
        eventCallback=OnEvent;
        Marshal.WriteIntPtr(logfile,424,Marshal.GetFunctionPointerForDelegate(eventCallback));
        consumer=OpenTraceW(logfile);
        if(consumer==UInt64.MaxValue) return (uint)Marshal.GetLastWin32Error();
        var thread=new Thread(delegate() { traceResult=ProcessTrace(new[]{consumer},1,IntPtr.Zero,IntPtr.Zero); if(!stopping) stopping=true; });
        thread.IsBackground=true; thread.Start();
        return 0;
    }
    static void Stop()
    {
        stopping=true;
        if(session!=0) { ControlTraceW(session,sessionName,properties,1); session=0; }
        if(consumer!=UInt64.MaxValue) { CloseTrace(consumer); consumer=UInt64.MaxValue; }
        // Buffers and pinned callbacks live until this short-lived helper exits.
    }
    static object Snapshot()
    {
        uint lost=0;
        if(session!=0 && ControlTraceW(session,sessionName,properties,0)==0)
            lost=unchecked((uint)Marshal.ReadInt32(properties,88))+unchecked((uint)Marshal.ReadInt32(properties,100));
        long at=Now(); Flow[] rows;
        lock(Gate) { rows=new Flow[Rows.Count]; Rows.Values.CopyTo(rows,0); Rows.Clear(); }
        var result=new { type="snapshot", generation=Generation, sequence=++sequence, at=at, duration=Math.Max(1,at-lastWindow),
            eventsLost=(long)lost+dropped+Interlocked.Read(ref malformed), rows=rows };
        lastWindow=at; return result;
    }
    static void SelfTest()
    {
        var bytes=new byte[44]; Array.Copy(BitConverter.GetBytes(1234),0,bytes,0,4); Array.Copy(BitConverter.GetBytes(2048),0,bytes,4,4);
        bytes[8]=203; bytes[9]=0; bytes[10]=113; bytes[11]=9; bytes[12]=192; bytes[13]=0; bytes[14]=2; bytes[15]=1;
        bytes[16]=1; bytes[17]=187; bytes[18]=195; bytes[19]=80;
        Flow send=Decode(Tcp,10,2,bytes),recv=Decode(Udp,11,2,bytes),tcpRecv=Decode(Tcp,11,2,bytes);
        if(send.upload!=2048 || send.download!=0 || send.destinationIP!="203.0.113.9" || send.destinationPort!=443 || send.sourcePort!=50000 || recv.download!=2048 || recv.destinationIP!="192.0.2.1") throw new Exception("IPv4 parser failed");
        if(tcpRecv.download!=2048 || tcpRecv.sourceIP!="192.0.2.1" || tcpRecv.sourcePort!=50000 || tcpRecv.destinationIP!="203.0.113.9" || tcpRecv.destinationPort!=443) throw new Exception("TCP receive tuple failed");
        Array.Clear(bytes,8,36); bytes[23]=1; bytes[39]=2; bytes[40]=1; bytes[41]=187; bytes[42]=195; bytes[43]=80;
        if(Decode(Tcp,26,2,bytes).destinationIP!="::1" || Decode(Udp,27,2,bytes).destinationIP!="::2" || Decode(Tcp,14,2,bytes)!=null) throw new Exception("IPv6/parser filtering failed");
        if(Decode(Tcp,27,2,bytes).destinationIP!="::1" || Decode(Tcp,27,2,bytes).destinationPort!=443) throw new Exception("IPv6 TCP receive tuple failed");
        var mdns=new Flow { network="udp", processId=10, processBorn=100, sourceIP="10.0.0.5", sourcePort=5353, destinationIP="10.0.0.21", destinationPort=5353 };
        AssignFlowId(mdns,"gen"); if(mdns.id!="gen:10:100:udp:discovery:5353" || mdns.destinationIP!="224.0.0.251") throw new Exception("LAN discovery aggregation failed");
        var tray=new Flow { network="tcp", processId=20, processBorn=200, sourceIP="127.0.0.1", sourcePort=51001, destinationIP="127.0.0.1", destinationPort=43128 };
        AssignFlowId(tray,"gen"); if(tray.id!="gen:20:200:tcp:loopback:127.0.0.1:43128" || tray.sourcePort!=0) throw new Exception("Known loopback aggregation failed");
        var ipc=new Flow { network="tcp", processId=30, processBorn=300, sourceIP="127.0.0.1", sourcePort=51002, destinationIP="127.0.0.1", destinationPort=54321 };
        AssignFlowId(ipc,"gen"); if(ipc.id!="gen:30:300:tcp:loopback:127.0.0.1" || ipc.destinationPort!=0) throw new Exception("Ephemeral loopback aggregation failed");
        var pub=new Flow { network="udp", processId=40, processBorn=400, sourceIP="192.0.2.1", sourcePort=5353, destinationIP="203.0.113.9", destinationPort=5353 };
        AssignFlowId(pub,"gen"); if(pub.id!="gen:40:400:udp:192.0.2.1:5353:203.0.113.9:5353") throw new Exception("Public UDP tuple must stay intact");
        Console.WriteLine("Native ETW parser self-test passed (TCP/UDP, IPv4/IPv6, receive PID, retransmit excluded, LAN/loopback aggregated).");
    }
    static int Main(string[] args)
    {
        if(args.Length==1 && args[0]=="--self-test") { SelfTest(); return 0; }
        int parent;
        if(args.Length!=3 || !System.Text.RegularExpressions.Regex.IsMatch(args[0],"^codex-netwatch-native-[a-f0-9]{32}$") || !Int32.TryParse(args[1],out parent) || !System.Text.RegularExpressions.Regex.IsMatch(args[2],"^[a-f0-9]{64}$")) return 2;
        try {
            using(var pipe=new NamedPipeClientStream(".",args[0],PipeDirection.InOut,PipeOptions.None)) {
                pipe.Connect(15000);
                uint owner;
                if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out owner) || owner!=parent) return 3;
                using(var writer=new StreamWriter(pipe,new UTF8Encoding(false),4096,true))
                using(var reader=new StreamReader(pipe,Encoding.UTF8,false,4096,true)) {
                    writer.AutoFlush=true;
                    uint code=Start();
                    if(code!=0) { writer.WriteLine(Json.Serialize(new { type="error",token=args[2],code=code,issue=code==5 || code==1314?"elevation_required":"native_failed" })); return 1; }
                    writer.WriteLine(Json.Serialize(new { type="ready",token=args[2],generation=Generation }));
                    string command;
                    while(!stopping && (command=reader.ReadLine())!=null) {
                        if(command=="snapshot") writer.WriteLine(Json.Serialize(Snapshot()));
                        else if(command=="stop") break;
                        else break;
                    }
                }
            }
            return 0;
        } catch { return 1; }
        finally { Stop(); }
    }
}
