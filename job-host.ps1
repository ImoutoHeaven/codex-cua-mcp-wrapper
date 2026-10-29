param([Parameter(Mandatory = $true)][int]$WrapperId)
# Runs the backend inside a Windows job object that is closed, killing every process in it, when the backend's root
# exits, when the wrapper exits, or when this host is killed. Writes nothing to stdout: it belongs to the backend.
$ErrorActionPreference = 'Stop'
$argv = [string[]](ConvertFrom-Json -InputObject $env:CUA_JOB_HOST_ARGV -NoEnumerate)
Remove-Item -LiteralPath Env:CUA_JOB_HOST_ARGV
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class CuaJobHost {
 [StructLayout(LayoutKind.Sequential)]
 struct BasicLimits {
  public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
  public uint LimitFlags;
  public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
  public uint ActiveProcessLimit;
  public UIntPtr Affinity;
  public uint PriorityClass, SchedulingClass;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct ExtendedLimits {
  public BasicLimits Basic;
  public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
 }
 [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
 struct StartupInfo {
  public int cb;
  public string lpReserved, lpDesktop, lpTitle;
  public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
  public short wShowWindow, cbReserved2;
  public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
 }
 [StructLayout(LayoutKind.Sequential)]
 struct ProcessInformation { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

 [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
 static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
  bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
 [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
 [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
 [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForMultipleObjects(int count, IntPtr[] handles, bool all, uint ms);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out int code);
 [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
 [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

 const uint Synchronize = 0x00100000, KillOnJobClose = 0x2000, CreateSuspended = 0x4, UseStdHandles = 0x100, Inherit = 1, Infinite = 0xFFFFFFFF;

 static Exception Fail(string what) { return new Win32Exception(Marshal.GetLastWin32Error(), what + " failed"); }

 // Quotes one argument so CommandLineToArgvW and the C runtime read it back unchanged.
 static string Quote(string arg) {
  if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
  var s = new StringBuilder("\"");
  int slashes = 0;
  foreach (char c in arg) {
   if (c == '\\') { slashes++; continue; }
   s.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
   slashes = 0;
   s.Append(c);
  }
  return s.Append('\\', slashes * 2).Append('"').ToString();
 }

 public static int Run(int wrapperId, string[] argv) {
  IntPtr wrapper = IntPtr.Zero, job = IntPtr.Zero, process = IntPtr.Zero, thread = IntPtr.Zero;
  try {
   wrapper = OpenProcess(Synchronize, false, wrapperId);
   if (wrapper == IntPtr.Zero) throw Fail("OpenProcess(wrapper)");
   job = CreateJobObjectW(IntPtr.Zero, null);
   if (job == IntPtr.Zero) throw Fail("CreateJobObject");
   var limits = new ExtendedLimits();
   limits.Basic.LimitFlags = KillOnJobClose;
   if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)))) throw Fail("SetInformationJobObject");

   var startup = new StartupInfo();
   startup.cb = Marshal.SizeOf(typeof(StartupInfo));
   startup.dwFlags = (int)UseStdHandles;
   startup.hStdInput = GetStdHandle(-10);
   startup.hStdOutput = GetStdHandle(-11);
   startup.hStdError = GetStdHandle(-12);
   foreach (var handle in new[] { startup.hStdInput, startup.hStdOutput, startup.hStdError }) {
    if (!SetHandleInformation(handle, Inherit, Inherit)) throw Fail("SetHandleInformation(standard handle)");
   }
   var line = new StringBuilder();
   foreach (var arg in argv) line.Append(line.Length > 0 ? " " : "").Append(Quote(arg));
   ProcessInformation info;
   if (!CreateProcessW(null, line, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended, IntPtr.Zero, null, ref startup, out info)) throw Fail("CreateProcess(" + argv[0] + ")");
   process = info.hProcess;
   thread = info.hThread;
   if (!AssignProcessToJobObject(job, process)) {
    var error = Fail("AssignProcessToJobObject");
    TerminateProcess(process, 1);
    throw error;
   }
   if (ResumeThread(thread) == 0xFFFFFFFF) throw Fail("ResumeThread");
   // Only the backend may hold the protocol channel, so the wrapper sees end-of-file when the backend closes it.
   // This host writes nothing to stdout; stderr stays open for its diagnostics.
   CloseHandle(startup.hStdInput);
   CloseHandle(startup.hStdOutput);

   uint woken = WaitForMultipleObjects(2, new[] { process, wrapper }, false, Infinite);
   if (woken == 0xFFFFFFFF) throw Fail("WaitForMultipleObjects");
   if (woken != 0) return 1;
   int code;
   if (!GetExitCodeProcess(process, out code)) throw Fail("GetExitCodeProcess");
   return code;
  } finally {
   // Closing the only job handle ends every process still in the job, including a suspended root.
   foreach (var handle in new[] { thread, job, process, wrapper }) if (handle != IntPtr.Zero) CloseHandle(handle);
  }
 }
}
'@
exit ([CuaJobHost]::Run($WrapperId, $argv))
