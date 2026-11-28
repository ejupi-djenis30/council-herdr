param([Parameter(Mandatory=$true)][string]$App)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'process.ps1')
$scratch=Join-Path $env:TEMP ('cou7-process-replay-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$out=Join-Path $scratch 'out.txt'; $err=Join-Path $scratch 'err.txt'
$directOut=Join-Path $scratch 'direct-out.txt'; $directErr=Join-Path $scratch 'direct-err.txt'
& (Join-Path $env:SystemRoot 'System32/cmd.exe') /d /c 'exit 37'
& $App --version 1>$directOut 2>$directErr
$direct=$LASTEXITCODE
$good=Invoke-Cou7Process $App @('--version') $out $err 10000
$version=(Get-Content -Raw $out).Trim()
$bad=Invoke-Cou7Process (Join-Path $env:SystemRoot 'System32/cmd.exe') @('/d','/c','exit 37') $out $err 10000
if ($direct -ne 37 -or $good -ne 0 -or $bad -ne 37 -or $version -ne 'herdr-app 0.1.18') { throw 'process_wait_replay_failed' }
@{ observedDirectStaleExit=$direct; waitedVersion=$version; waitedExit=$good; syntheticFailureExit=$bad;
   executableSha256=(Get-FileHash -Algorithm SHA256 $App).Hash.ToLowerInvariant();
   limitation='Read-only CLI version probe on Windows ARM64 with x64 emulation; no Desktop window or Core started.' } | ConvertTo-Json -Compress
