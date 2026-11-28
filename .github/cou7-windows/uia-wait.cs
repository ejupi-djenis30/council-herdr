using System;
using System.Runtime.InteropServices;
using System.Windows.Automation;

public static class Cou7UiaWait {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateEvent(IntPtr attr, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll")] static extern bool SetEvent(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static bool AcceptAfterWait(uint waitResult, bool present) { return waitResult != 0xffffffff && present; }
    static bool Has(AutomationElement root, string name, bool enabled) {
        try {
            var elements = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, name));
            foreach (AutomationElement element in elements) if (!enabled || element.Current.IsEnabled) return true;
            return false;
        }
        catch (Exception) { return false; }
    }
    public static bool WaitName(long hwnd, string name, uint timeoutMilliseconds) {
        return Wait(hwnd, name, timeoutMilliseconds, false);
    }
    public static bool WaitEnabled(long hwnd, string name, uint timeoutMilliseconds) {
        return Wait(hwnd, name, timeoutMilliseconds, true);
    }
    static bool Wait(long hwnd, string name, uint timeoutMilliseconds, bool enabled) {
        var root = AutomationElement.FromHandle(new IntPtr(hwnd));
        var signal = CreateEvent(IntPtr.Zero, true, false, null);
        if (signal == IntPtr.Zero) throw new InvalidOperationException("uia_event_creation_failed");
        StructureChangedEventHandler structure = (sender, args) => { if (Has(root,name,enabled)) SetEvent(signal); };
        AutomationPropertyChangedEventHandler property = (sender, args) => { if (Has(root,name,enabled)) SetEvent(signal); };
        bool s = false, p = false;
        try {
            Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, structure); s = true;
            Automation.AddAutomationPropertyChangedEventHandler(root, TreeScope.Subtree, property, AutomationElement.NameProperty, AutomationElement.IsEnabledProperty); p = true;
            if (Has(root,name,enabled)) SetEvent(signal);
            uint waited = WaitForSingleObject(signal, timeoutMilliseconds);
            // Some providers expose the new tree without raising UIA events.
            return AcceptAfterWait(waited, Has(root,name,enabled));
        } finally {
            if (p) Automation.RemoveAutomationPropertyChangedEventHandler(root, property);
            if (s) Automation.RemoveStructureChangedEventHandler(root, structure);
            CloseHandle(signal);
        }
    }
}
