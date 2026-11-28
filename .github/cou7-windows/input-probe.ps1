$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Cou7Win {
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
$proc = Get-Process -Id $PID
$session = $proc.SessionId
$active = [Cou7Win]::WTSGetActiveConsoleSessionId()
$desktop = [Cou7Win]::OpenInputDesktop(0, $false, 0x0001)
$desktopError = if ($desktop -eq [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::GetLastWin32Error() } else { 0 }
$result = [ordered]@{ processSession = $session; activeConsoleSession = $active; userInteractive = [Environment]::UserInteractive;
  inputDesktopOpen = ($desktop -ne [IntPtr]::Zero); inputDesktopError = $desktopError; ownWindowVisible = $false;
  foreground = $false; nativeInputObserved = $false; firstFailure = $null }
if ($desktop -ne [IntPtr]::Zero) { [void][Cou7Win]::CloseDesktop($desktop) }
if ($session -ne $active) { $result.firstFailure = 'process_session_differs_from_active_console' }
elseif (-not $result.userInteractive) { $result.firstFailure = 'process_not_interactive' }
elseif (-not $result.inputDesktopOpen) { $result.firstFailure = 'open_input_desktop_failed' }
else {
  $form = [Windows.Forms.Form]::new()
  $form.Text = 'COU7 isolated input test'; $form.Width = 360; $form.Height = 140
  $box = [Windows.Forms.TextBox]::new(); $box.Left = 20; $box.Top = 20; $box.Width = 250
  $form.Controls.Add($box); $form.Show(); [Windows.Forms.Application]::DoEvents()
  $result.ownWindowVisible = [Cou7Win]::IsWindowVisible($form.Handle)
  [void][Cou7Win]::SetForegroundWindow($form.Handle); [void][Cou7Win]::SetFocus($box.Handle)
  [Windows.Forms.Application]::DoEvents()
  $result.foreground = ([Cou7Win]::GetForegroundWindow() -eq $form.Handle)
  if ($result.foreground) {
    [Cou7Win]::keybd_event(0x41, 0, 0, [UIntPtr]::Zero)
    [Cou7Win]::keybd_event(0x41, 0, 2, [UIntPtr]::Zero)
    $until = [Diagnostics.Stopwatch]::StartNew()
    while ($until.ElapsedMilliseconds -lt 2000 -and $box.Text.Length -eq 0) { [Windows.Forms.Application]::DoEvents() }
    $result.nativeInputObserved = ($box.Text -match '^[aA]$')
  }
  if (-not $result.ownWindowVisible) { $result.firstFailure = 'owned_window_not_visible' }
  elseif (-not $result.foreground) { $result.firstFailure = 'owned_window_not_foreground' }
  elseif (-not $result.nativeInputObserved) { $result.firstFailure = 'native_key_input_postcondition_absent' }
  if ($result.foreground -and $env:COU7_EVIDENCE) {
    try {
      # Capture only the synthetic form interior, never surrounding desktop content.
      $bitmap = [Drawing.Bitmap]::new(300, 65)
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($form.Left + 20, $form.Top + 40, 0, 0, [Drawing.Size]::new(300, 65))
      $bitmap.Save((Join-Path $env:COU7_EVIDENCE 'owned-input-window.png'), [Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose(); $bitmap.Dispose()
      $result['ownedWindowScreenshot'] = 'captured'
    } catch { $result['ownedWindowScreenshot'] = 'unavailable' }
  }
  $form.Close(); $form.Dispose()
}
$result | ConvertTo-Json -Compress
