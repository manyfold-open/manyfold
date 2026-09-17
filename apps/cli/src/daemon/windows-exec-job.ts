// Fixed supervisor source; argv is JSON data, never PowerShell source.
export const WINDOWS_EXEC_JOB_SCRIPT = String.raw`
param([string]$SpecPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ManyfoldExecJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit; public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
        public IntPtr Process, Thread; public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string arg) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    public static int Run(string[] args, string cwd, string cancel, string receipt) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        ProcessInfo child = new ProcessInfo(); bool assigned = false;
        try {
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            var command = new StringBuilder();
            foreach (string arg in args) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
            var startup = new StartupInfo(); startup.Size = (uint)Marshal.SizeOf(startup);
            startup.Flags = 0x100; startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
            Check(CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 4, IntPtr.Zero, cwd, ref startup, out child));
            Check(AssignProcessToJobObject(job, child.Process)); assigned = true;
            if (ResumeThread(child.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(child.Thread); child.Thread = IntPtr.Zero;
            uint result = 0;
            while (true) {
                if (File.Exists(cancel)) { result = 143; break; }
                uint wait = WaitForSingleObject(child.Process, 20);
                if (wait == 0) { Check(GetExitCodeProcess(child.Process, out result)); break; }
                if (wait != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            Check(TerminateJobObject(job, result));
            var elapsed = Stopwatch.StartNew();
            while (true) {
                Accounting accounting;
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.ActiveProcesses == 0) break;
                if (elapsed.ElapsedMilliseconds >= 2000) throw new InvalidOperationException("owned job did not drain");
                System.Threading.Thread.Sleep(10);
            }
            File.WriteAllText(receipt, "drained");
            return unchecked((int)result);
        } finally {
            if (!assigned && child.Process != IntPtr.Zero) { TerminateProcess(child.Process, 1); WaitForSingleObject(child.Process, 2000); }
            // Setup failure before ResumeThread must also prove the job empty.
            if (!File.Exists(receipt) && TerminateJobObject(job, 1)) {
                var cleanup = Stopwatch.StartNew();
                while (cleanup.ElapsedMilliseconds < 2000) {
                    Accounting accounting;
                    if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) break;
                    if (accounting.ActiveProcesses == 0) { File.WriteAllText(receipt, "drained"); break; }
                    System.Threading.Thread.Sleep(10);
                }
            }
            CloseHandle(job);
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
        }
    }
}
'@
try {
    $spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $result = [ManyfoldExecJob]::Run([string[]]$spec.cmd, [string]$spec.cwd, [string]$spec.cancel, [string]$spec.receipt)
    exit $result
} catch {
    [Console]::Error.WriteLine('owned Windows exec setup or cleanup failed')
    exit 1
}
`
