param([Parameter(Mandatory=$true)][string]$Facts,[Parameter(Mandatory=$true)][string]$Positive,
      [Parameter(Mandatory=$true)][string]$Negative,[Parameter(Mandatory=$true)][string]$OtherNegative)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'tab-template.ps1')
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$diag=($records | Where-Object stage -eq 'ui_diagnostic').value
$attempt=($records | Where-Object stage -eq 'ui_create_exit').value
if($failure.code -ne 'uia_expected_control_absent' -or $failure.stage -ne 'Work items' -or @($diag.elements).Count -ne 0 -or $attempt.saveAttempted -or $attempt.delegateAttempted) { throw 'saved_tab_reproduction_mismatch' }
$template=[Drawing.Bitmap]::FromFile((Join-Path $PSScriptRoot 'work-items-template.png'))
$results=@()
try {
  foreach($case in @(@('positive',$Positive),@('welcome',$Negative),@('form',$OtherNegative))) {
    $frame=[Drawing.Bitmap]::FromFile($case[1])
    try {
      $zero=Get-Cou7TabPlan $frame $template 0 0
      $offset=Get-Cou7TabPlan $frame $template 200 100
      if ($case[0] -eq 'positive') {
        if (-not $zero.matched -or -not $offset.matched -or ($zero.point -join ',') -ne '391,246' -or ($offset.point -join ',') -ne '591,346') { throw 'positive_tab_plan_mismatch' }
      } elseif ($zero.matched -or $offset.matched -or $null -ne $zero.point -or $null -ne $offset.point) { throw 'negative_tab_emitted_input' }
      $results+=@{case=$case[0];score=$zero.score;positive=$zero.matched;negativeEmitsInput=($case[0] -ne 'positive' -and $null -ne $zero.point)}
    } finally { $frame.Dispose() }
  }
} finally { $template.Dispose() }
@{ sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46183004168'; observed='tab_visible_but_uia_tree_empty';
   cases=$results; origins='zero_and_200_100'; inputActuallyEmitted=$false;
   limitation='Replay uses stored synthetic screenshots; live window focus, PID and geometry must still be verified.' } | ConvertTo-Json -Compress -Depth 6
