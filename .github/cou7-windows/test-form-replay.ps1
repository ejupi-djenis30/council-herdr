param([Parameter(Mandatory=$true)][string]$Facts, [Parameter(Mandatory=$true)][string]$Frame)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'pixel-check.cs')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs=@([System.Windows.Automation.AutomationElement].Assembly.Location,[System.Windows.Automation.TreeScope].Assembly.Location,[System.Runtime.InteropServices.DllImportAttribute].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot 'uia-wait.cs') -ReferencedAssemblies $refs
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$diagnostic=($records | Where-Object stage -eq 'ui_diagnostic').value
$save=@($diagnostic.elements | Where-Object name -eq 'Save work item')
$edits=@($diagnostic.elements | Where-Object type -eq 'ControlType.Edit')
if ($failure.code -ne 'uia_expected_control_absent' -or $save.Count -ne 1 -or -not $save[0].enabled -or $edits.Count -ne 2 -or @($edits | Where-Object valuePattern).Count -ne 0) { throw 'saved_uia_reproduction_mismatch' }
if (-not [Cou7UiaWait]::AcceptAfterWait(258,($save.Count -eq 1)) -or [Cou7UiaWait]::AcceptAfterWait(258,$false) -or [Cou7UiaWait]::AcceptAfterWait([uint32]::MaxValue,$true)) { throw 'uia_wait_boundary_mismatch' }
$bmp=[Drawing.Bitmap]::FromFile($Frame)
try {
  $a=$bmp.GetPixel(90,632); $b=$bmp.GetPixel(205,632)
  $disabled=[Cou7PixelCheck]::Primary($a.R,$a.G,$a.B,$b.R,$b.G,$b.B)
  if ($disabled -ne 'disabled_or_light') { throw 'saved_disabled_button_mismatch' }
  if ([Cou7PixelCheck]::Primary(27,27,30,27,27,30) -ne 'enabled') { throw 'synthetic_dark_control_mismatch' }
} finally { $bmp.Dispose() }
@{ sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46181128990';
   immediateUiaWait='failed_but_control_present'; uiaSaveEnabled=$true; visibleSave=$disabled;
   editValuePattern='unavailable'; syntheticDarkControl='enabled';
   limitation='The dark positive is synthetic. Clipboard typing and the selected role require the next native run.' } | ConvertTo-Json -Compress
