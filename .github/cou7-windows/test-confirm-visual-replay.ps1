param([Parameter(Mandatory=$true)][string]$Facts,[Parameter(Mandatory=$true)][string]$Positive,
      [Parameter(Mandatory=$true)][string]$Negative,[Parameter(Mandatory=$true)][string]$OtherNegative)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'tab-template.ps1')
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$item=($records | Where-Object stage -eq 'ui_uncertain_item').value
if($failure.code -ne 'uia_control_not_actionable' -or $failure.stage -ne 'Confirm delegation' -or $item.state -ne 'draft' -or $null -ne $item.job) {throw 'saved_confirm_reproduction_mismatch'}
$title=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'confirm-title-template.png'))
$role=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'confirm-role-template.png'))
$button=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'confirm-button-template.png'))
$results=@()
try {
  foreach($case in @(@('positive',$Positive),@('item',$Negative),@('form',$OtherNegative))) {
    $frame=[Drawing.Bitmap]::FromFile($case[1])
    try {
      $zero=Get-Cou7ConfirmPlan $frame $title $role $button 0 0
      $offset=Get-Cou7ConfirmPlan $frame $title $role $button 200 100
      if($case[0] -eq 'positive') {
        if(-not $zero.matched -or -not $offset.matched -or ($zero.point -join ',') -ne '174,441' -or ($offset.point -join ',') -ne '374,541') {throw 'positive_confirm_plan_mismatch'}
      } elseif($zero.matched -or $offset.matched -or $null -ne $zero.point -or $null -ne $offset.point) {throw 'negative_confirm_emitted_input'}
      $results+=@{case=$case[0];titleScore=$zero.titleScore;roleScore=$zero.roleScore;buttonScore=$zero.buttonScore;matched=$zero.matched;negativeEmitsInput=($case[0] -ne 'positive' -and $null -ne $zero.point)}
    } finally {$frame.Dispose()}
  }
} finally {$title.Dispose();$role.Dispose();$button.Dispose()}
@{sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46185952103';observed='confirm_visible_but_uia_actionability_failed_before_click';
  savedItem='draft_without_job';cases=$results;origins='zero_and_200_100';inputActuallyEmitted=$false;
  limitation='Actor readback, native gesture and delivery require verification in the next run.'} | ConvertTo-Json -Compress -Depth 6
