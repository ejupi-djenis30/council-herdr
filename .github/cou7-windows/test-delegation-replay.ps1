param([Parameter(Mandatory=$true)][string]$Facts,[Parameter(Mandatory=$true)][string]$Positive,
      [Parameter(Mandatory=$true)][string]$Negative,[Parameter(Mandatory=$true)][string]$OtherNegative)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'tab-template.ps1')
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$delivery=($records | Where-Object stage -eq 'delivery_observation').value
$same=($records | Where-Object stage -eq 'ui_reopen_same_item').value
if($failure.code -ne 'uia_expected_control_absent' -or $failure.stage -ne 'Copy session ID' -or $delivery.id -ne $same.id -or $delivery.assignmentCount -ne 1) { throw 'saved_delegation_reproduction_mismatch' }
$criteria=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'delegation-criteria-template.png'))
$button=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'delegation-copy-template.png'))
$capture=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'delegation-capture-template.png'))
$results=@()
try {
  foreach($case in @(@('positive',$Positive),@('item',$Negative),@('handoff',$OtherNegative))) {
    $frame=[Drawing.Bitmap]::FromFile($case[1])
    try {
      $zero=Get-Cou7DelegationPlan $frame $criteria $button $capture 0 0
      $offset=Get-Cou7DelegationPlan $frame $criteria $button $capture 200 100
      if($case[0] -eq 'positive') {
        if(-not $zero.matched -or -not $offset.matched -or ($zero.point -join ',') -ne '166,442' -or ($offset.point -join ',') -ne '366,542') {throw 'positive_delegation_plan_mismatch'}
      } elseif($zero.matched -or $offset.matched -or $null -ne $zero.point -or $null -ne $offset.point) {throw 'negative_delegation_emitted_input'}
      $results+=@{case=$case[0];criteriaScore=$zero.criteriaScore;captureScore=$zero.captureScore;buttonScore=$zero.buttonScore;matched=$zero.matched;negativeEmitsInput=($case[0] -ne 'positive' -and $null -ne $zero.point)}
    } finally {$frame.Dispose()}
  }
} finally {$criteria.Dispose();$button.Dispose();$capture.Dispose()}
@{sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46185530333';observed='delegation_and_copy_control_visible_but_uia_missing';
  assignmentCount=$delivery.assignmentCount;cases=$results;origins='zero_and_200_100';inputActuallyEmitted=$false;
  limitation='Clipboard correlation and live PID, focus and geometry must still be verified in the next native run.'} | ConvertTo-Json -Compress -Depth 6
