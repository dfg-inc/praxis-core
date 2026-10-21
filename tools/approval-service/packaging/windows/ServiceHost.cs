// Praxis Approval Service host. node.exe is not a Windows service host, so this small program is: it runs as the service
// account, starts Node with a clean environment, restarts it if it exits, stops it on service stop, and sets the DACL of
// the service's named pipe once the pipe exists. Compiled at install time with the OS-provided C# compiler (csc.exe).
// STATUS: UNTESTED. This code has not been compiled or run on Windows by the author.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.ServiceProcess;
using System.Threading;

public class PraxisApprovalServiceHost : ServiceBase
{
    const string PipeName = @"\\.\pipe\praxis-approval-service";
    const string Account = @"NT SERVICE\PraxisApproval";
    volatile bool stopping;
    Process child;
    Thread worker;

    public PraxisApprovalServiceHost()
    {
        ServiceName = "PraxisApproval";
        CanStop = true;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        worker = new Thread(Run) { IsBackground = true };
        worker.Start();
    }

    protected override void OnStop()
    {
        stopping = true;
        try { if (child != null && !child.HasExited) { child.Kill(); child.WaitForExit(10000); } } catch { }
    }

    void Run()
    {
        string code = AppDomain.CurrentDomain.BaseDirectory;
        string config = Path.Combine(Environment.GetEnvironmentVariable("ProgramData"), "Praxis", "ApprovalService", "config.json");
        while (!stopping)
        {
            var psi = new ProcessStartInfo(Path.Combine(code, "node", "node.exe"),
                "\"" + Path.Combine(code, "praxis-approval-service.mjs") + "\" run --config \"" + config + "\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.Combine(Environment.GetEnvironmentVariable("ProgramData"), "Praxis", "ApprovalService", "state")
            };
            psi.EnvironmentVariables.Clear();
            string system = Environment.GetEnvironmentVariable("SystemRoot");
            psi.EnvironmentVariables["SystemRoot"] = system;
            psi.EnvironmentVariables["PATH"] = Path.Combine(system, "System32");
            psi.EnvironmentVariables["PRAXIS_BUNDLE_KIND"] = "production";
            child = Process.Start(psi);
            ApplyPipeDacl();
            child.WaitForExit();
            if (!stopping) Thread.Sleep(5000);
        }
    }

    // ---- named pipe DACL ----------------------------------------------------------------------------------------------
    // SYSTEM, Administrators and the service account: full. Authenticated Users: read/write (the Runtime client connects as
    // the user; nothing on the pipe approves anything). NETWORK: denied, so the pipe is not reachable over SMB.
    void ApplyPipeDacl()
    {
        for (int i = 0; i < 60 && !stopping; i++)
        {
            if (Array.IndexOf(Directory.GetFiles(@"\\.\pipe\"), PipeName) >= 0) break;
            Thread.Sleep(500);
        }
        string sid = new NTAccount(Account).Translate(typeof(SecurityIdentifier)).Value;
        string sddl = "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + sid + ")(A;;GRGW;;;AU)";
        IntPtr sd;
        uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out sd, out size)) return;
        bool present, defaulted;
        IntPtr dacl;
        if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted)) return;
        IntPtr handle = CreateFile(PipeName, 0x00040000 /* WRITE_DAC */, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (handle == new IntPtr(-1)) return;
        try { SetSecurityInfo(handle, 6 /* SE_KERNEL_OBJECT */, 0x80000004 /* PROTECTED | DACL */, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero); }
        finally { CloseHandle(handle); }
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr sd, out uint size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern uint SetSecurityInfo(IntPtr handle, int objectType, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    public static void Main() { ServiceBase.Run(new PraxisApprovalServiceHost()); }
}
