$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root=$env:COU7_ROOT; $hc=$env:COU7_HC; $cli=$env:COU7_CLI; $node=$env:COU7_NODE
$ready=Join-Path $root 'fixture-ready.json'
function Fact([string]$stage,$value) { @{stage=$stage;value=$value} | ConvertTo-Json -Depth 12 -Compress }
function Invoke-Cou7Hc([string[]]$arguments) { $out=& $hc @arguments 2>$null; if($LASTEXITCODE -ne 0){return $null}; return ($out | Out-String | ConvertFrom-Json) }
function Invoke-Cou7Cli([string[]]$arguments) { Push-Location $env:COU7_UI_PROJECT; try { $out=& $node $cli @arguments 2>$null; if($LASTEXITCODE -ne 0){return $null};return ($out | Out-String | ConvertFrom-Json) } finally { Pop-Location } }
try {
  if (-not (Test-Path -LiteralPath $ready)) {
    $watcher=[IO.FileSystemWatcher]::new($root,'fixture-ready.json')
    $name='cou7-ready-' + [Guid]::NewGuid().ToString('N')
    $subscription=Register-ObjectEvent -InputObject $watcher -EventName Renamed -SourceIdentifier $name
    try {
      $watcher.EnableRaisingEvents=$true
      if (-not (Test-Path -LiteralPath $ready)) { $event=Wait-Event -SourceIdentifier $name -Timeout 65 }
    } finally {
      $watcher.EnableRaisingEvents=$false; Unregister-Event -SourceIdentifier $name -ErrorAction SilentlyContinue; $watcher.Dispose()
      if ($event) { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue }
    }
  }
  if (-not (Test-Path -LiteralPath $ready)) { throw 'fixture_ready_not_observed' }
  $fixture=Get-Content -Raw $ready | ConvertFrom-Json
  if ($fixture.address -notmatch '^t[0-9a-z]+$' -or $fixture.pid -le 0) { throw 'fixture_ready_invalid' }
  $participant=Invoke-Cou7Hc @('get','--json',$fixture.address)
  $terminals=Invoke-Cou7Hc @('ls','--all','--json')
  $workers=@($terminals.terminals | Where-Object { $_.name -like 'c-job-*' })
  if ($workers.Count -ne 1) { throw 'owned_worker_not_unique' }
  $worker=$workers[0]
  $participantProcess=Get-Process -Id $fixture.pid -ErrorAction SilentlyContinue
  $sameNode=($null -ne $participantProcess -and $participantProcess.Path -eq $node)
  $pOut=Join-Path $root 'participant-wait.json'; $pErr=Join-Path $root 'participant-wait.err'
  $wOut=Join-Path $root 'worker-wait.json'; $wErr=Join-Path $root 'worker-wait.err'
  $pWait=Start-Process -FilePath $hc -ArgumentList @('wait','--json',$fixture.address,'--timeout','80') -PassThru -WindowStyle Hidden -RedirectStandardOutput $pOut -RedirectStandardError $pErr
  $wWait=Start-Process -FilePath $hc -ArgumentList @('wait','--json',$worker.address,'--timeout','80') -PassThru -WindowStyle Hidden -RedirectStandardOutput $wOut -RedirectStandardError $wErr
  Set-Content -Encoding ascii -LiteralPath (Join-Path $root 'fixture-release.txt') -Value 'release'
  if (-not $pWait.WaitForExit(90000) -or -not $wWait.WaitForExit(90000)) { throw 'owned_wait_process_timeout' }
  $p=Get-Content -Raw $pOut | ConvertFrom-Json; $w=Get-Content -Raw $wOut | ConvertFrom-Json
  $participantAlive=$null -ne (Get-Process -Id $fixture.pid -ErrorAction SilentlyContinue)
  $created=Get-Content -Raw (Join-Path $root 'ui-created.json') | ConvertFrom-Json
  $item=(Invoke-Cou7Cli @('work-item','show','--id',$created.id)).item
  $session=$item.job.sessionId
  $status=Invoke-Cou7Cli @('status','--session',$session); $result=Invoke-Cou7Cli @('result','--session',$session)
  $events=@(Get-Content (Join-Path $root 'fixture-events.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  $launches=@(Get-Content (Join-Path $root 'fixture-launches.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  $output=[string]$item.result.output
  $record=@{ interface='Core_and_installed_CLI'; id=$item.id; title=$item.title; criteria=$item.criteria; roleId=$item.roleId;
    revision=$item.lifecycle.revision; state=$item.state; nextAction=$item.nextAction; job=$item.job;
    participantBefore=@{address=$participant.address;turn=$participant.turn;state=$participant.state;status=$participant.status.state};
    participantWait=@{ended=$p.ended;reason=$p.reason;turn=$p.turn;status=$p.status;cliExit=$pWait.ExitCode};
    workerBefore=@{address=$worker.address;state=$worker.state;turn=$worker.turn};
    workerWait=@{ended=$w.ended;reason=$w.reason;exitCode=$w.exit_code;cliExit=$wWait.ExitCode};
    fixturePidMatchesNode=$sameNode; fixturePidAliveAfterWorker=$participantAlive;
    jobReadback=@{sessionId=$status.sessionId;state=$status.state;deliveryState=$status.deliveryState;address=$status.participant.address;power=$status.participant.power;workerAddress=$status.worker.address};
    resultReadback=@{sessionId=$result.sessionId;ready=$result.ready;turn=$result.turn};
    resultSource=$item.result.source; captureScope=$item.result.captureScope;
    expectedHeading=$output.Contains('Heading: # Windows Native Checkpoint'); expectedNext=$output.Contains('Next action: compare the heading with the saved criteria.');
    events=@($events | ForEach-Object event); assignmentCount=@($events | Where-Object event -eq 'assignment').Count; launchCount=$launches.Count }
  Fact 'delivery_observation' $record
  $ok=($item.id -eq $created.id -and $item.title -eq 'Windows native checkpoint' -and $created.revision -ge 1 -and $item.lifecycle.revision -ge $created.revision -and $item.roleId -eq 'verifier' -and ($item.criteria -join "`n") -eq "Name the first heading.`nGive a concrete next action." -and
       $item.state -eq 'result_ready' -and $item.job.linked -eq $true -and $item.job.deliveryState -eq 'acknowledged' -and $item.job.outcome -eq 'completed' -and
       $status.sessionId -eq $session -and $result.sessionId -eq $session -and $result.ready -eq $true -and $status.participant.address -eq $fixture.address -and $status.participant.power -eq 'off' -and
       $worker.address -eq $status.worker.address -and $p.ended -eq $true -and $p.reason -eq 'status' -and $p.status -eq 'done' -and $pWait.ExitCode -eq 0 -and $p.turn -gt $participant.turn -and $participant.status.state -eq 'working' -and $result.turn -eq $p.turn -and
       $w.ended -eq $true -and $w.reason -eq 'exit' -and $w.exit_code -eq 0 -and $wWait.ExitCode -eq 0 -and $sameNode -and -not $participantAlive -and
       $record.expectedHeading -and $record.expectedNext -and $record.resultSource -eq 'terminal_screen' -and $item.nextAction -eq 'Review the handoff against the acceptance criteria.' -and $record.assignmentCount -eq 1 -and $record.launchCount -eq 1 -and @($record.events | Where-Object { $_ -eq 'result' }).Count -eq 1 -and 'error' -notin $record.events)
  Fact 'delivery_verdict' @{ pass=$ok }
  if (-not $ok) { exit 1 }
} catch {
  $message=$_.Exception.Message; $code=if($message -cmatch '^[a-z][a-z0-9_]+$'){$message}else{'unclassified_collection_exception'}
  Fact 'delivery_failure' @{ code=$code; exceptionType=$_.Exception.GetType().Name }
  exit 1
}
