using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Windows.Forms;
using System.Text;

namespace TrafficWatch.Security {
  internal static class Program {
    [STAThread] static int Main(string[] args) {
      try {
        if (args.Length == 1 && args[0] == "identity") { Console.WriteLine(WindowsIdentity.GetCurrent().User.Value); return 0; }
        if (args.Length == 2 && (args[0] == "protect" || args[0] == "unprotect")) {
          var data = Convert.FromBase64String(Console.In.ReadToEnd().Trim());
          var scope = args[1] == "machine" ? DataProtectionScope.LocalMachine : DataProtectionScope.CurrentUser;
          var entropy = Encoding.UTF8.GetBytes("TrafficWatch/vault-1");
          byte[] result = args[0] == "protect" ? ProtectedData.Protect(data, entropy, scope) : ProtectedData.Unprotect(data, entropy, scope);
          Console.Write(Convert.ToBase64String(result)); Array.Clear(data,0,data.Length); Array.Clear(result,0,result.Length); return 0;
        }
        if (args.Length != 2 || args[0] != "watch") return 2;
        using (var guard = new GuardWindow(args[1])) Application.Run();
        return 0;
      } catch { Console.Error.WriteLine("vault_guard_failed"); return 1; }
    }
  }
  internal sealed class GuardWindow : NativeWindow, IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct Session { public int Id; public IntPtr Name; public int State; }
    [DllImport("wtsapi32.dll")] static extern bool WTSEnumerateSessions(IntPtr server,int reserved,int version,out IntPtr data,out int count);
    [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int infoClass,out IntPtr buffer,out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("wtsapi32.dll")] static extern bool WTSRegisterSessionNotification(IntPtr window,int flags);
    [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr window);
    readonly string owner; readonly Timer timer; long epoch = 1; string previous = "";
    public GuardWindow(string ownerSid) {
      owner = ownerSid; CreateHandle(new CreateParams { Caption="TrafficWatch Session Guard" });
      if (!WTSRegisterSessionNotification(Handle,1)) throw new Exception();
      timer = new Timer { Interval=500 }; timer.Tick += (sender,e)=>Emit(false); timer.Start(); Emit(false);
    }
    static string QueryText(int id,int kind) {
      IntPtr data; int size;
      if (!WTSQuerySessionInformation(IntPtr.Zero,id,kind,out data,out size)) return "";
      try { return Marshal.PtrToStringAnsi(data) ?? ""; } finally { WTSFreeMemory(data); }
    }
    string State() {
      IntPtr data; int count;
      if (!WTSEnumerateSessions(IntPtr.Zero,0,1,out data,out count)) return "unknown";
      bool found=false;
      try {
        int stride=Marshal.SizeOf(typeof(Session));
        for(int i=0;i<count;i++) {
          var session=(Session)Marshal.PtrToStructure(IntPtr.Add(data,i*stride),typeof(Session));
          string user=QueryText(session.Id,5), domain=QueryText(session.Id,7);
          if (user.Length==0) continue;
          try { if (((SecurityIdentifier)new NTAccount(domain,user).Translate(typeof(SecurityIdentifier))).Value!=owner) continue; } catch { continue; }
          found=true; if(session.State!=0) continue;
          IntPtr details; int size;
          if(!WTSQuerySessionInformation(IntPtr.Zero,session.Id,25,out details,out size)) continue;
          try {
            // WTSINFOEX level 1: DWORD level, 4 byte union alignment,
            // DWORD session id, DWORD connection state, LONG flags.
            if(size>=20 && Marshal.ReadInt32(details,0)==1 && Marshal.ReadInt32(details,8)==session.Id && Marshal.ReadInt32(details,16)==1) return "unlocked";
          } finally { WTSFreeMemory(details); }
        }
      } finally { WTSFreeMemory(data); }
      return found ? "locked" : "logged_out";
    }
    void Emit(bool reset) {
      string state=State(); if(reset || state!=previous) epoch++; previous=state;
      long at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      Console.WriteLine("{\"state\":\""+state+"\",\"epoch\":"+epoch+",\"reset\":"+(reset?"true":"false")+",\"at\":"+at+"}");
      Console.Out.Flush();
    }
    protected override void WndProc(ref Message message) {
      if(message.Msg==0x02B1) {
        int change=message.WParam.ToInt32(); Emit(change==6 || change==2 || change==4);
      }
      if(message.Msg==0x0218) Emit(true);
      base.WndProc(ref message);
    }
    public void Dispose() { timer.Stop(); timer.Dispose(); WTSUnRegisterSessionNotification(Handle); DestroyHandle(); }
  }
}
