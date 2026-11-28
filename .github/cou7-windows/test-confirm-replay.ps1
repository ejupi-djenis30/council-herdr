param([Parameter(Mandatory=$true)][string]$Facts)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'confirm-readback.ps1')
$records=@(Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json })
$failure=($records | Where-Object stage -eq 'ui_failure').value
$attempt=($records | Where-Object stage -eq 'ui_create_exit').value
$created=($records | Where-Object stage -eq 'ui_created_readback').value
$delivery=($records | Where-Object stage -eq 'delivery_observation').value
if($failure.stage -ne 'Open delegation' -or $failure.code -ne 'uia_expected_control_absent' -or -not $attempt.delegateAttempted -or $delivery.assignmentCount -ne 1) { throw 'saved_confirmation_reproduction_mismatch' }
$item=[pscustomobject]@{id=$delivery.id;job=$delivery.job}
if (-not (Test-Cou7ConfirmReadback $item $created.id)) { throw 'valid_same_item_rejected' }
if (Test-Cou7ConfirmReadback $item 'wi-other') { throw 'different_item_accepted' }
$unlinked=[pscustomobject]@{id=$created.id;job=[pscustomobject]@{linked=$false;sessionId=$delivery.job.sessionId}}
if (Test-Cou7ConfirmReadback $unlinked $created.id) { throw 'unlinked_job_accepted' }
$invalid=[pscustomobject]@{id=$created.id;job=[pscustomobject]@{linked=$true;sessionId='wi-job-invalid'}}
if (Test-Cou7ConfirmReadback $invalid $created.id) { throw 'malformed_job_accepted' }
@{ sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46183559371';
   observed='uia_missing_after_single_confirmation'; sameItemLinkedJob='accepted'; differentOrUnlinkedOrMalformed='rejected';
   additionalSends=0; limitation='The replay is read-only and uses the saved synthetic observation.' } | ConvertTo-Json -Compress
