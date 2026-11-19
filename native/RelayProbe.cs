using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Authentication;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class RelayProbe {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    [DllImport("iphlpapi.dll")]
    static extern uint GetBestInterfaceEx(byte[] destination,out uint interfaceIndex);
    static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static void Emit(object value) { Console.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static Socket Bound(string local,int index,SocketType type,ProtocolType protocol) {
        Socket socket=new Socket(AddressFamily.InterNetwork,type,protocol);
        if(index>0) socket.SetSocketOption(SocketOptionLevel.IP,(SocketOptionName)31,IPAddress.HostToNetworkOrder(index));
        if(!String.IsNullOrEmpty(local))socket.Bind(new IPEndPoint(IPAddress.Parse(local),0));
        socket.ReceiveTimeout=8000; socket.SendTimeout=8000; return socket;
    }
    static object Discover() {
        var adapters=new List<object>();
        foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()) {
            if(nic.OperationalStatus!=OperationalStatus.Up || (nic.NetworkInterfaceType!=NetworkInterfaceType.Ethernet && nic.NetworkInterfaceType!=NetworkInterfaceType.Wireless80211)) continue;
            if(System.Text.RegularExpressions.Regex.IsMatch(nic.Name+nic.Description,"tun|mihomo|clash|meta|virtual|loopback",System.Text.RegularExpressions.RegexOptions.IgnoreCase))continue;
            var props=nic.GetIPProperties();var v4=props.UnicastAddresses.FirstOrDefault(a=>a.Address.AddressFamily==AddressFamily.InterNetwork&&!a.Address.ToString().StartsWith("169.254."));
            var gw=props.GatewayAddresses.FirstOrDefault(a=>a.Address.AddressFamily==AddressFamily.InterNetwork&&!a.Address.Equals(IPAddress.Any));
            if(v4==null||gw==null)continue;
            adapters.Add(new { index=props.GetIPv4Properties().Index,address=v4.Address.ToString(),gateway=gw.Address.ToString(),name=nic.Name,description=nic.Description,ipv6=props.UnicastAddresses.Where(a=>a.Address.AddressFamily==AddressFamily.InterNetworkV6&&!a.Address.IsIPv6LinkLocal).Select(a=>a.Address.ToString()).ToArray() });
        }
        return new {kind="network",at=Now(),adapters=adapters};
    }
    static object Interfaces() {
        var adapters=new List<object>();
        foreach(var nic in NetworkInterface.GetAllNetworkInterfaces()) {
            try {
                var props=nic.GetIPProperties();int ipv4=0,ipv6=0;
                if(nic.Supports(NetworkInterfaceComponent.IPv4))ipv4=props.GetIPv4Properties().Index;
                if(nic.Supports(NetworkInterfaceComponent.IPv6))ipv6=props.GetIPv6Properties().Index;
                adapters.Add(new {name=nic.Name,status=nic.OperationalStatus.ToString(),ipv4=ipv4,ipv6=ipv6});
            }catch{}
        }
        // Ask Windows which interface it would use. This never sends a packet.
        var routes=new List<object>();
        foreach(string address in new[]{"1.1.1.1","8.8.8.8","208.67.222.222","2606:4700:4700::1111","2001:4860:4860::8888"}) {
            var ip=IPAddress.Parse(address);var endpoint=new IPEndPoint(ip,0).Serialize();
            var buffer=new byte[endpoint.Size];for(int i=0;i<buffer.Length;i++)buffer[i]=endpoint[i];
            uint index;
            if(GetBestInterfaceEx(buffer,out index)==0&&index>0)routes.Add(new {family=ip.AddressFamily==AddressFamily.InterNetwork?4:6,index=index});
        }
        return new {kind="interfaces",at=Now(),adapters=adapters,routes=routes};
    }
    static int U16(byte[] b,int p) { return (b[p]<<8)|b[p+1]; }
    static string DnsName(byte[] b,ref int p) {
        var labels=new List<string>();int pos=p,end=-1,steps=0;
        while(pos<b.Length&&++steps<128) { int n=b[pos++]; if(n==0)break; if((n&192)==192){if(pos>=b.Length)throw new IOException();int ptr=((n&63)<<8)|b[pos++];if(end<0)end=pos;pos=ptr;continue;}if(n>63||pos+n>b.Length)throw new IOException();labels.Add(Encoding.ASCII.GetString(b,pos,n));pos+=n; }
        if(steps>=128)throw new IOException();p=end<0?pos:end;return String.Join(".",labels);
    }
    static object Dns(string host,string local,int index,string resolver) {
        if(!System.Text.RegularExpressions.Regex.IsMatch(host,"^[a-zA-Z0-9.-]{1,253}$"))throw new ArgumentException();
        var rows=new List<object>();var cnames=new List<string>();long start=Now();
        foreach(int type in new int[]{1,28}) {
            byte[] id=new byte[2];using(var random=System.Security.Cryptography.RandomNumberGenerator.Create())random.GetBytes(id);
            var query=new List<byte>(new byte[]{id[0],id[1],1,0,0,1,0,0,0,0,0,0});foreach(string label in host.Split('.')){query.Add((byte)label.Length);query.AddRange(Encoding.ASCII.GetBytes(label));}query.AddRange(new byte[]{0,0,(byte)type,0,1});
            using(Socket socket=Bound(local,index,SocketType.Dgram,ProtocolType.Udp)) {
                socket.ReceiveTimeout=2500;socket.Connect(new IPEndPoint(IPAddress.Parse(resolver),53));socket.Send(query.ToArray());
                byte[] answer=new byte[4096];int length=socket.Receive(answer);Array.Resize(ref answer,length);
                if(length<12||answer[0]!=id[0]||answer[1]!=id[1]||(answer[3]&15)!=0||(answer[2]&2)!=0)throw new IOException("dns_invalid_or_truncated");
                int p=12;int qd=U16(answer,4),an=U16(answer,6);for(int i=0;i<qd;i++){DnsName(answer,ref p);p+=4;}
                for(int i=0;i<an&&p+12<=answer.Length;i++) {
                    string name=DnsName(answer,ref p);int recordType=U16(answer,p),size=U16(answer,p+8);uint ttl=(uint)((answer[p+4]<<24)|(answer[p+5]<<16)|(answer[p+6]<<8)|answer[p+7]);p+=10;if(p+size>answer.Length)throw new IOException();
                    if(recordType==1&&size==4||recordType==28&&size==16){byte[] bytes=new byte[size];Array.Copy(answer,p,bytes,0,size);rows.Add(new {ip=new IPAddress(bytes).ToString(),type=recordType==1?"A":"AAAA",ttl=ttl});}
                    if(recordType==5){int cp=p;cnames.Add(DnsName(answer,ref cp));}p+=size;
                }
            }
        }
        return new {kind="dns",at=start,host=host,records=rows,cnames=cnames,ms=Now()-start,interfaceIndex=index,localAddress=local,resolver=resolver};
    }
    static object Probe(string host,string ip,string local,int index,bool hold) {
        var result=new Dictionary<string,object>{{"kind","probe"},{"at",Now()},{"host",host},{"ip",ip},{"via",index>0?"physical-bound":"ordinary"},{"interfaceIndex",index},{"phase","tcp"}};
        Stopwatch clock=Stopwatch.StartNew();Socket socket=null;Timer deadline=null;
        try {
            socket=Bound(local,index,SocketType.Stream,ProtocolType.Tcp);Socket active=socket;deadline=new Timer(delegate {try {active.Close();}catch{}},null,12000,Timeout.Infinite);
            socket.Connect(new IPEndPoint(IPAddress.Parse(ip),443));var endpoint=(IPEndPoint)socket.LocalEndPoint;
            result["source"]=endpoint.Address.ToString();result["sourcePort"]=endpoint.Port;result["connectMs"]=clock.ElapsedMilliseconds;
            if(hold)Emit(new {kind="connected",at=Now(),host=host,ip=ip,source=endpoint.Address.ToString(),sourcePort=endpoint.Port,interfaceIndex=index,pid=Process.GetCurrentProcess().Id});
            result["phase"]="tls";
            using(var stream=new SslStream(new NetworkStream(socket,false),false)) {
                stream.AuthenticateAsClient(host,null,SslProtocols.Tls12,false);result["tlsMs"]=clock.ElapsedMilliseconds-(long)result["connectMs"];result["tlsProtocol"]="Tls12";result["phase"]="headers";
                byte[] request=Encoding.ASCII.GetBytes("GET /v1/models HTTP/1.1\r\nHost: "+host+"\r\nUser-Agent: TrafficWatch-connectivity/1\r\nConnection: close\r\n\r\n");stream.Write(request,0,request.Length);
                var head=new List<byte>();int b;while(head.Count<2048&&(b=stream.ReadByte())>=0){head.Add((byte)b);if(b==10)break;}
                string line=Encoding.ASCII.GetString(head.ToArray());int code;if(!line.StartsWith("HTTP/")||!Int32.TryParse(line.Split(' ')[1],out code))throw new IOException("http_eof");
                result["status"]=code;result["firstByteMs"]=clock.ElapsedMilliseconds;result["phase"]="complete";result["receivedBytes"]=head.Count;result["sentBytes"]=request.Length;
                if(hold)Thread.Sleep(1200);
            }
        }catch(Exception e){result["errorType"]=e.GetType().Name;result["errorCode"]=e.HResult;if(Environment.GetEnvironmentVariable("TRAFFICWATCH_DIAGNOSTIC_SELFTEST")=="1")result["selfTestDetail"]=e.Message;var se=e as SocketException;if(se!=null)result["socketError"]=se.SocketErrorCode.ToString();}
        finally{if(deadline!=null)deadline.Dispose();if(socket!=null)socket.Dispose();}
        result["durationMs"]=clock.ElapsedMilliseconds;return result;
    }
    public static int Main(string[] args) {
        Console.OutputEncoding=new UTF8Encoding(false);
        try {
            if(args.Length==1&&args[0]=="discover"){Emit(Discover());return 0;}
            if(args.Length==1&&args[0]=="interfaces"){Emit(Interfaces());return 0;}
            var input=Json.Deserialize<Dictionary<string,object>>(Console.ReadLine());string mode=Convert.ToString(input["mode"]),host=Convert.ToString(input["host"]),local=Convert.ToString(input["localAddress"]);int index=Convert.ToInt32(input["interfaceIndex"]);
            if(mode=="dns")Emit(Dns(host,local,index,Convert.ToString(input["resolver"])));
            else if(mode=="probe")Emit(Probe(host,Convert.ToString(input["ip"]),local,index,input.ContainsKey("hold")&&Convert.ToBoolean(input["hold"])));
            else throw new ArgumentException();return 0;
        }catch(Exception e){Emit(new {kind="error",at=Now(),code="network_operation_failed",type=e.GetType().Name});return 1;}
    }
}
