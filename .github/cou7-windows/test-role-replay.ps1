param([Parameter(Mandatory=$true)][string]$Facts,[Parameter(Mandatory=$true)][string]$Frame)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'pixel-check.cs')
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$uiExit=($records | Where-Object stage -eq 'ui_create_exit').value
$diagnostic=($records | Where-Object stage -eq 'ui_diagnostic').value
$role=@($diagnostic.elements | Where-Object name -eq 'Windows fixture · verifier')
if ($failure.code -ne 'save_not_visually_enabled_after_role' -or $uiExit.saveAttempted -or $uiExit.delegateAttempted -or $role.Count -ne 1) { throw 'saved_role_reproduction_mismatch' }
$bmp=[Drawing.Bitmap]::FromFile($Frame)
try {
  $a=$bmp.GetPixel(90,632);$b=$bmp.GetPixel(205,632);$left=$bmp.GetPixel(90,590);$right=$bmp.GetPixel(235,590)
  if ([Cou7PixelCheck]::Primary($a.R,$a.G,$a.B,$b.R,$b.G,$b.B) -ne 'disabled_or_light') { throw 'save_not_gray_in_frame' }
  if ($left.R -lt 240 -or $right.R -lt 240) { throw 'role_not_white_in_frame' }
} finally { $bmp.Dispose() }
if ([Cou7PixelCheck]::RoleMethod($true,$true) -ne 'selection' -or [Cou7PixelCheck]::RoleMethod($false,$true) -ne 'invoke' -or [Cou7PixelCheck]::RoleMethod($false,$false) -ne 'keyboard') { throw 'role_method_choice_mismatch' }
@{ sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46182254836';
   observed='role_white_and_save_gray_after_mouse_attempt'; saveGestures=0; delegateGestures=0;
   syntheticChoiceTests='one_selection_or_invoke_or_keyboard';
   limitation='The supported UIA pattern and actual role selection require the next native run.' } | ConvertTo-Json -Compress
