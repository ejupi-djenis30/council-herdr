using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;

// Watches only a supplied, owned process. Events are delivered by UI Automation;
// the initial enumeration closes the registration race without retaining other windows.
public static class Cou7WindowWatch {
    delegate bool EnumCallback(IntPtr hwnd, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateEvent(IntPtr attr, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll")] static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    public static bool Eligible(int expected, int actual, long handle, bool visible) {
        return expected == actual && handle != 0 && visible;
    }
    public static long Wait(int expected, uint timeoutMilliseconds) {
        long found = 0;
        IntPtr signal = CreateEvent(IntPtr.Zero, true, false, null);
        if (signal == IntPtr.Zero) throw new InvalidOperationException("window_event_creation_failed");
        AutomationEventHandler handler = (sender, args) => {
            try {
                var element = sender as AutomationElement;
                if (element == null) return;
                int pid = element.Current.ProcessId;
                long hwnd = element.Current.NativeWindowHandle;
                if (Eligible(expected, pid, hwnd, IsWindowVisible(new IntPtr(hwnd)))) {
                    found = hwnd;
                    SetEvent(signal);
                }
            } catch (Exception) { }
        };
        bool registered = false;
        try {
            Automation.AddAutomationEventHandler(WindowPattern.WindowOpenedEvent, AutomationElement.RootElement, TreeScope.Children, handler);
            registered = true;
            EnumWindows((hwnd, ignored) => {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (Eligible(expected, (int)pid, hwnd.ToInt64(), IsWindowVisible(hwnd))) {
                    found = hwnd.ToInt64();
                    SetEvent(signal);
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            WaitForSingleObject(signal, timeoutMilliseconds);
            return found;
        } finally {
            if (registered) Automation.RemoveAutomationEventHandler(WindowPattern.WindowOpenedEvent, AutomationElement.RootElement, handler);
            CloseHandle(signal);
        }
    }
}
