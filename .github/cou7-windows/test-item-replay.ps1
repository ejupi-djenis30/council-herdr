param([Parameter(Mandatory=$true)][string]$Facts,[Parameter(Mandatory=$true)][string]$Positive,
      [Parameter(Mandatory=$true)][string]$Negative,[Parameter(Mandatory=$true)][string]$OtherNegative)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'tab-template.ps1')
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$delivery=($records | Where-Object stage -eq 'delivery_observation').value
$overlay=($records | Where-Object stage -eq 'overlay_transition').value
if($failure.code -ne 'uia_expected_control_absent' -or $failure.stage -ne 'Open work item' -or $delivery.assignmentCount -ne 1 -or -not $overlay.before -or $overlay.closed -or -not $overlay.reopened) { throw 'saved_item_reproduction_mismatch' }
$title=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'item-title-template.png'))
$button=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'open-item-template.png'))
$results=@()
try {
  foreach($case in @(@('positive',$Positive),@('initial',$Negative),@('form',$OtherNegative))) {
    $frame=[Drawing.Bitmap]::FromFile($case[1])
    try {
      $zero=Get-Cou7ItemPlan $frame $title $button 0 0
      $offset=Get-Cou7ItemPlan $frame $title $button 200 100
      if($case[0] -eq 'positive') {
        if(-not $zero.matched -or -not $offset.matched -or ($zero.point -join ',') -ne '166,591' -or ($offset.point -join ',') -ne '366,691') { throw 'positive_item_plan_mismatch' }
      } elseif($zero.matched -or $offset.matched -or $null -ne $zero.point -or $null -ne $offset.point) { throw 'negative_item_emitted_input' }
      $results+=@{case=$case[0];titleScore=$zero.titleScore;buttonScore=$zero.buttonScore;matched=$zero.matched;negativeEmitsInput=($case[0] -ne 'positive' -and $null -ne $zero.point)}
    } finally { $frame.Dispose() }
  }
} finally { $title.Dispose();$button.Dispose() }
@{sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46183862683';observed='same_item_visible_but_uia_button_missing';
  assignmentCount=$delivery.assignmentCount;cases=$results;origins='zero_and_200_100';inputActuallyEmitted=$false;
  limitation='Replay uses synthetic screenshots; live PID, focus, geometry and same-item CLI readback are still required.'} | ConvertTo-Json -Compress -Depth 6
