param([ValidateSet('capture','create','reopen')][string]$Mode = 'create')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$refs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.TreeScope].Assembly.Location, [System.Runtime.InteropServices.DllImportAttribute].Assembly.Location)
Add-Type -Path (Join-Path $env:COU7_HARNESS '.github/cou7-windows/uia-wait.cs') -ReferencedAssemblies $refs
Add-Type -Path (Join-Path $env:COU7_HARNESS '.github/cou7-windows/pixel-check.cs')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Cou7UiInput {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
'@
$hwnd = [IntPtr][long]$env:COU7_WINDOW_HANDLE
$pidExpected = [int]$env:COU7_APP_PID
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$stage = 'initial'; $last = 'none'
$title = 'Windows native checkpoint'
$criteria = @('Name the first heading.','Give a concrete next action.')
function Record([string]$name, $value) { @{ stage=$name; value=$value } | ConvertTo-Json -Compress -Depth 10 }
function Mark([string]$name) { $script:last=$name; Record 'ui_reached' @{ name=$name; interface='native_UIA_and_input' } }
function CheckWindow {
  if ($root.Current.ProcessId -ne $pidExpected) { throw 'uia_process_mismatch' }
  [void][Cou7UiInput]::SetForegroundWindow($hwnd)
  if ([Cou7UiInput]::GetForegroundWindow() -ne $hwnd) { throw 'uia_window_not_foreground' }
}
function Nodes([string]$name) {
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name)
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition) | ForEach-Object { $_ })
}
function One([string]$name) {
  $nodes = @(Nodes $name | Where-Object { -not $_.Current.IsOffscreen })
  if ($nodes.Count -ne 1) { throw "uia_control_count_$($nodes.Count)" }
  return $nodes[0]
}
function FrameBarrier {
  $fileName='frame-' + [Guid]::NewGuid().ToString('N') + '.png'
  $path=Join-Path $env:COU7_ROOT $fileName
  $watcher=[IO.FileSystemWatcher]::new($env:COU7_ROOT,$fileName)
  $id='cou7-frame-' + [Guid]::NewGuid().ToString('N')
  $subscription=Register-ObjectEvent -InputObject $watcher -EventName Created -SourceIdentifier $id
  try {
    $watcher.EnableRaisingEvents=$true
    & $env:COU7_APP 'shot' $path 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'desktop_frame_request_failed' }
    if (-not (Test-Path -LiteralPath $path)) { $event=Wait-Event -SourceIdentifier $id -Timeout 15 }
    if (-not (Test-Path -LiteralPath $path)) { throw 'desktop_frame_not_observed' }
  } finally {
    $watcher.EnableRaisingEvents=$false; Unregister-Event -SourceIdentifier $id -ErrorAction SilentlyContinue; $watcher.Dispose()
    if ($event) { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue }
  }
}
function Await([string]$name) {
  $script:stage = $name
  FrameBarrier
  if (-not [Cou7UiaWait]::WaitName($hwnd.ToInt64(),$name,12000)) { throw 'uia_expected_control_absent' }
}
function Click($element) {
  CheckWindow
  if (-not $element.Current.IsEnabled -or $element.Current.IsOffscreen) { throw 'uia_control_not_actionable' }
  $rect=$element.Current.BoundingRectangle; $window=[Cou7UiInput+RECT]::new()
  if (-not [Cou7UiInput]::GetWindowRect($hwnd,[ref]$window)) { throw 'window_geometry_unavailable' }
  $x=[int][Math]::Round($rect.Left+$rect.Width/2); $y=[int][Math]::Round($rect.Top+$rect.Height/2)
  if ($rect.IsEmpty -or $x -le $window.Left -or $x -ge $window.Right -or $y -le $window.Top -or $y -ge $window.Bottom) { throw 'uia_control_outside_owned_window' }
  if (-not [Cou7UiInput]::SetCursorPos($x,$y)) { throw 'native_pointer_failed' }
  [Cou7UiInput]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [Cou7UiInput]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
function Edits {
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition) | Where-Object { -not $_.Current.IsOffscreen } | Sort-Object { $_.Current.BoundingRectangle.Top })
}
function SetEdit($element,[string]$text) {
  CheckWindow
  $pattern=$null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $pattern.SetValue($text) }
  else {
    if ($text -notmatch '^[a-zA-Z0-9.\s]+$') { throw 'unsafe_fixture_text' }
    Click $element
    [Windows.Forms.SendKeys]::SendWait('^a')
    [Windows.Forms.SendKeys]::SendWait(($text -replace "`r`n","`n").Replace("`n",'{ENTER}'))
  }
  FrameBarrier
  AssertEdit $element $text
}
function AssertEdit($element,[string]$expected) {
  $pattern=$null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $actual=$pattern.Current.Value }
  else {
    [Windows.Forms.Clipboard]::SetText('COU7 synthetic sentinel')
    Click $element
    [Windows.Forms.SendKeys]::SendWait('^a'); [Windows.Forms.SendKeys]::SendWait('^c')
    FrameBarrier
    $actual=[Windows.Forms.Clipboard]::GetText()
  }
  if (($actual -replace "`r`n","`n") -ne ($expected -replace "`r`n","`n")) { throw 'uia_edit_readback_mismatch' }
}
function PrimaryState($element) {
  CheckWindow
  $r=$element.Current.BoundingRectangle
  if ($r.IsEmpty -or $r.Width -lt 20 -or $r.Height -lt 10) { throw 'primary_button_geometry_invalid' }
  $bmp=[Drawing.Bitmap]::new(2,1); $graphics=[Drawing.Graphics]::FromImage($bmp)
  try {
    $y=[int]($r.Top+[Math]::Floor($r.Height/2))
    $graphics.CopyFromScreen([int]($r.Left+5),$y,0,0,[Drawing.Size]::new(1,1))
    $graphics.CopyFromScreen([int]($r.Right-6),$y,1,0,[Drawing.Size]::new(1,1))
    $a=$bmp.GetPixel(0,0); $b=$bmp.GetPixel(1,0)
    return [Cou7PixelCheck]::Primary($a.R,$a.G,$a.B,$b.R,$b.G,$b.B)
  } finally { $graphics.Dispose(); $bmp.Dispose() }
}
function Shot([string]$name) {
  try {
    CheckWindow
    $r=[Cou7UiInput+RECT]::new(); if (-not [Cou7UiInput]::GetWindowRect($hwnd,[ref]$r)) { return }
    $w=$r.Right-$r.Left-32; $h=$r.Bottom-$r.Top-32
    if ($w -lt 100 -or $h -lt 100 -or $w -gt 4000 -or $h -gt 3000) { return }
    $bitmap=[Drawing.Bitmap]::new($w,$h); $graphics=[Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($r.Left+16,$r.Top+16,0,0,[Drawing.Size]::new($w,$h))
    $bitmap.Save((Join-Path $env:COU7_EVIDENCE "ui-$name.png"),[Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
    Record 'ui_screenshot' @{ stage=$name; interface='native_screen_crop' }
  } catch { Record 'ui_screenshot_unavailable' @{ stage=$name } }
}
function Cli([string[]]$arguments) {
  Push-Location $env:COU7_UI_PROJECT
  try { $output=& $env:COU7_NODE $env:COU7_CLI 'work-item' @arguments 2>$null; if ($LASTEXITCODE -ne 0) { throw 'installed_cli_readback_failed' }; return ($output | Out-String | ConvertFrom-Json) }
  finally { Pop-Location }
}
function Attempt([string]$name) {
  Set-Content -LiteralPath (Join-Path $env:COU7_ROOT "ui-$name-attempted") -Value 'one native gesture' -Encoding utf8
  Record 'ui_mutation_attempted' @{ name=$name }
}
function HandoffText {
  $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $parts=[Collections.Generic.List[string]]::new()
  foreach($element in $all) {
    try {
      if ($element.Current.Name) { $parts.Add($element.Current.Name) }
      $pattern=$null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { $parts.Add($pattern.Current.Value) }
      $pattern=$null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) { $parts.Add($pattern.DocumentRange.GetText(-1)) }
    } catch { }
  }
  return ($parts -join "`n")
}
function Diagnostic {
  try {
    $allow=@('Work items','New work item','Save work item','Refresh roles','Windows fixture · verifier','Delegate','Confirm delegation','Open delegation','Read saved handoff','Back to work item','Copy session ID','Open work item')
    $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $elements=@(foreach($element in $all) {
      try {
        $name=$element.Current.Name; $type=$element.Current.ControlType.ProgrammaticName
        if ($name -in $allow -or $type -eq 'ControlType.Edit') {
          $r=$element.Current.BoundingRectangle; $pattern=$null
          @{ name=if($name -in $allow){$name}else{'<edit>'}; type=$type; enabled=$element.Current.IsEnabled; offscreen=$element.Current.IsOffscreen;
             valuePattern=$element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$pattern);
             x=[int]$r.Left; y=[int]$r.Top; width=[int]$r.Width; height=[int]$r.Height }
        }
      } catch { }
    })
    Record 'ui_diagnostic' @{ stage=$stage; elements=$elements }
  } catch { }
}
try {
  if ($Mode -eq 'capture') { Shot 'desktop-initial'; Mark 'desktop_initial'; exit 0 }
  if ($Mode -eq 'create') {
    Await 'Work items'; Click (One 'Work items')
    Await 'New work item'; Shot 'list'; Mark 'list'
    Click (One 'New work item')
    Await 'Save work item'; Await 'Refresh roles'
    $edits=@(Edits); if ($edits.Count -ne 2) { throw 'uia_create_edit_count_mismatch' }
    $save=One 'Save work item'; if ((PrimaryState $save) -ne 'disabled_or_light') { throw 'save_initial_visual_state_unexpected' }
    SetEdit $edits[0] $title
    SetEdit $edits[1] ($criteria -join "`n")
    $save=One 'Save work item'; if ((PrimaryState $save) -ne 'disabled_or_light') { throw 'save_enabled_before_role' }
    $role=One 'Windows fixture · verifier'; Click $role
    FrameBarrier
    $save=One 'Save work item'; if ((PrimaryState $save) -ne 'enabled') { throw 'save_not_visually_enabled_after_role' }
    # Read the controls again immediately before the sole save gesture.
    $edits=@(Edits); if ($edits.Count -ne 2) { throw 'uia_create_edit_count_mismatch' }
    AssertEdit $edits[0] $title
    AssertEdit $edits[1] ($criteria -join "`n")
    FrameBarrier; $save=One 'Save work item'; if ((PrimaryState $save) -ne 'enabled') { throw 'save_not_visually_enabled_before_gesture' }
    Record 'ui_role_selection' @{ before='disabled_or_light'; after='enabled'; evidence='native_pixel_transition_and_field_readback' }
    Shot 'form'; Mark 'form_values_and_role'
    Attempt 'save'; Click $save
    Await 'Delegate'; Shot 'created'
    $list=Cli @('list'); $items=@($list.items | Where-Object title -eq $title)
    if ($items.Count -ne 1) { throw 'created_item_readback_not_unique' }
    $item=(Cli @('show','--id',$items[0].id)).item
    if ($item.title -ne $title -or $item.roleId -ne 'verifier' -or ($item.criteria -join "`n") -ne ($criteria -join "`n")) { throw 'created_item_readback_mismatch' }
    @{ id=$item.id; title=$title; criteria=$criteria; roleId=$item.roleId; revision=$item.lifecycle.revision } | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $env:COU7_ROOT 'ui-created.json')
    Record 'ui_created_readback' @{ id=$item.id; roleId=$item.roleId; revision=$item.lifecycle.revision; interface='installed_CLI_readonly' }
    Click (One 'Delegate'); Await 'Confirm delegation'
    $edits=@(Edits); if ($edits.Count -ne 1) { throw 'uia_delegate_edit_count_mismatch' }
    SetEdit $edits[0] 'Operator'
    FrameBarrier
    $confirm=One 'Confirm delegation'; if ((PrimaryState $confirm) -ne 'enabled') { throw 'confirm_not_visually_enabled' }
    Shot 'delegate-form'; Mark 'delegate_form'
    Attempt 'delegate'; Click $confirm
    Await 'Open delegation'; Shot 'delegated'; Mark 'delegated'
    $current=(Cli @('show','--id',$item.id)).item
    if (-not $current.job.sessionId) { throw 'delegation_job_readback_missing' }
    @{ id=$item.id; sessionId=$current.job.sessionId } | ConvertTo-Json -Compress | Set-Content -Encoding utf8 (Join-Path $env:COU7_ROOT 'ui-job.json')
    Record 'ui_delegation_readback' @{ id=$item.id; sessionId=$current.job.sessionId; linked=$current.job.linked; interface='installed_CLI_readonly' }
  } else {
    $saved=Get-Content -Raw (Join-Path $env:COU7_ROOT 'ui-created.json') | ConvertFrom-Json
    $item=(Cli @('show','--id',$saved.id)).item
    if ($item.state -ne 'result_ready' -or -not $item.job.sessionId) { throw 'reopened_item_not_result_ready' }
    Await 'Work items'; Click (One 'Work items'); Await 'Open work item'
    $list=Cli @('list'); if (@($list.items | Where-Object title -eq $title).Count -ne 1) { throw 'reopened_item_not_unique' }
    Click (One 'Open work item'); Await 'Read saved handoff'; Await 'Open delegation'; Shot 'reopened-item'
    Click (One 'Read saved handoff'); Await 'Back to work item'; Shot 'reopened-handoff'; Mark 'reopened_handoff'
    $visibleText=HandoffText
    if (-not $visibleText.Contains('Heading: # Windows Native Checkpoint') -or -not $visibleText.Contains('Next action: compare the heading with the saved criteria.') -or -not $visibleText.Contains('Review the handoff against the acceptance criteria.')) { throw 'uia_handoff_content_not_observed' }
    Record 'ui_handoff_content' @{ heading=$true; outputNext=$true; guidance=$true }
    Click (One 'Back to work item'); Await 'Open delegation'; Click (One 'Open delegation'); Await 'Copy session ID'
    [Windows.Forms.Clipboard]::SetText('COU7 synthetic sentinel')
    Click (One 'Copy session ID')
    $copied=[Windows.Forms.Clipboard]::GetText().Trim()
    if ($copied -ne $item.job.sessionId) { throw 'reopened_session_id_mismatch' }
    Shot 'reopened-delegation'; Mark 'reopened_delegation'
    Record 'ui_session_match' @{ match=$true; sessionId=$item.job.sessionId; interface='native_UIA_and_clipboard' }
  }
  Record 'ui_success' @{ mode=$Mode }
} catch {
  try { Shot 'failed' } catch { }
  Diagnostic
  $message=$_.Exception.Message
  $code=if ($message -cmatch '^[a-z][a-z0-9_]+$') { $message } else { 'unclassified_ui_exception' }
  Record 'ui_failure' @{ stage=$stage; last=$last; code=$code; exceptionType=$_.Exception.GetType().Name }
  exit 1
}
