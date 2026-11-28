param([Parameter(Mandatory=$true)][string]$Facts,[Parameter(Mandatory=$true)][string]$Positive,[Parameter(Mandatory=$true)][string]$Negative)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$refs=@([System.Windows.Forms.NativeWindow].Assembly.Location,[System.Windows.Forms.Message].Assembly.Location,[System.Runtime.InteropServices.DllImportAttribute].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot 'clipboard-watch.cs') -ReferencedAssemblies $refs
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$attempt=($records | Where-Object stage -eq 'ui_create_exit').value
if($failure.code -ne 'uia_edit_readback_mismatch' -or $attempt.saveAttempted -or $attempt.delegateAttempted){throw 'saved_clipboard_reproduction_mismatch'}
$positiveImage=[Drawing.Bitmap]::FromFile($Positive);$negativeImage=[Drawing.Bitmap]::FromFile($Negative)
try {
  $p=$positiveImage.GetPixel(98,375);$n=$negativeImage.GetPixel(98,375)
  if(-not ($p.B -gt $p.R -and $p.B -gt $p.G -and $n.R -eq 255 -and $n.G -eq 255 -and $n.B -eq 255)){throw 'selected_title_frame_mismatch'}
} finally {$positiveImage.Dispose();$negativeImage.Dispose()}
if([Cou7ClipboardWatch]::AcceptSequence(7,7) -or -not [Cou7ClipboardWatch]::AcceptSequence(7,8)){throw 'clipboard_sequence_guard_mismatch'}
@{sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46184343312';
  observed='selected_title_visible_but_readback_mismatched';saveGestures=0;delegateGestures=0;
  sequenceGuard='unchanged_rejected_changed_accepted';inputActuallyEmitted=$false;
  limitation='The saved frame does not reveal clipboard contents or prove the cause; no native clipboard or window was touched in replay.'} | ConvertTo-Json -Compress
