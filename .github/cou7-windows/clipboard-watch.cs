using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Message-only window in the isolated test process; it observes clipboard changes
// without a timer or periodic reads of the clipboard.
public sealed class Cou7ClipboardWatch : NativeWindow, IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate; }
    [DllImport("user32.dll", SetLastError=true)] static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError=true)] static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr handles, uint milliseconds, uint wakeMask, uint flags);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG message, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG message);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    readonly uint baseline;
    public static bool AcceptSequence(uint before, uint after) { return before != after; }
    public Cou7ClipboardWatch() {
        CreateHandle(new CreateParams { Parent = new IntPtr(-3) });
        if (!AddClipboardFormatListener(Handle)) { DestroyHandle(); throw new InvalidOperationException("clipboard_listener_registration_failed"); }
        baseline = GetClipboardSequenceNumber();
    }
    public bool WaitForChange(uint timeoutMs) {
        ulong start=GetTickCount64();
        while (true) {
            if (AcceptSequence(baseline,GetClipboardSequenceNumber())) return true;
            ulong elapsed=GetTickCount64()-start;
            if (elapsed >= timeoutMs) return false;
            uint wait=MsgWaitForMultipleObjectsEx(0,IntPtr.Zero,(uint)(timeoutMs-elapsed),0x04ff,0x0004);
            if (wait==258) return AcceptSequence(baseline,GetClipboardSequenceNumber());
            if (wait==0xffffffff) throw new InvalidOperationException("clipboard_event_wait_failed");
            MSG message;
            while (PeekMessage(out message,IntPtr.Zero,0,0,1)) { TranslateMessage(ref message); DispatchMessage(ref message); }
        }
    }
    public void Dispose() { RemoveClipboardFormatListener(Handle); DestroyHandle(); }
}
