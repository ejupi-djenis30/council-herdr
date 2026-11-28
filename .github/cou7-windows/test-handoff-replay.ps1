param([Parameter(Mandatory=$true)][string]$Facts,[Parameter(Mandatory=$true)][string]$Positive,
      [Parameter(Mandatory=$true)][string]$Negative,[Parameter(Mandatory=$true)][string]$OtherNegative)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'tab-template.ps1')
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$delivery=($records | Where-Object stage -eq 'delivery_observation').value
$same=($records | Where-Object stage -eq 'ui_reopen_same_item').value
if($failure.code -ne 'uia_handoff_content_not_observed' -or $failure.last -ne 'reopened_handoff' -or $delivery.id -ne $same.id -or $delivery.assignmentCount -ne 1) { throw 'saved_handoff_reproduction_mismatch' }
$header=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'handoff-header-template.png'))
$guidance=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'handoff-guidance-template.png'))
$button=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'handoff-copy-template.png'))
$results=@()
try {
  foreach($case in @(@('positive',$Positive),@('item',$Negative),@('form',$OtherNegative))) {
    $frame=[Drawing.Bitmap]::FromFile($case[1])
    try {
      $zero=Get-Cou7HandoffPlan $frame $header $guidance $button 0 0
      $offset=Get-Cou7HandoffPlan $frame $header $guidance $button 200 100
      if($case[0] -eq 'positive') {
        if(-not $zero.matched -or -not $offset.matched -or ($zero.point -join ',') -ne '866,169' -or ($offset.point -join ',') -ne '1066,269') {throw 'positive_handoff_plan_mismatch'}
      } elseif($zero.matched -or $offset.matched -or $null -ne $zero.point -or $null -ne $offset.point) {throw 'negative_handoff_emitted_input'}
      $results+=@{case=$case[0];headerScore=$zero.headerScore;guidanceScore=$zero.guidanceScore;buttonScore=$zero.buttonScore;matched=$zero.matched;negativeEmitsInput=($case[0] -ne 'positive' -and $null -ne $zero.point)}
    } finally {$frame.Dispose()}
  }
} finally {$header.Dispose();$guidance.Dispose();$button.Dispose()}
@{sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46184910218';observed='same_handoff_and_guidance_visible_but_uia_text_missing';
  assignmentCount=$delivery.assignmentCount;cases=$results;origins='zero_and_200_100';inputActuallyEmitted=$false;
  limitation='Clipboard comparison and live PID, focus and geometry must still be verified in the next native run.'} | ConvertTo-Json -Compress -Depth 6
