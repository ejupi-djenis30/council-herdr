$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Join-Path $env:RUNNER_TEMP 'cou7-win-x64'
$evidence = Join-Path $env:RUNNER_TEMP 'cou7-win-evidence'
New-Item -ItemType Directory -Force -Path $root, $evidence | Out-Null
$facts = Join-Path $evidence 'facts.jsonl'
$env:COU7_ROOT = $root
$env:COU7_EVIDENCE = $evidence
$env:APPDATA = Join-Path $root 'appdata'
$env:LOCALAPPDATA = Join-Path $root 'localappdata'
$env:HOME = Join-Path $root 'home'
$env:USERPROFILE = $env:HOME
$env:XDG_CONFIG_HOME = Join-Path $root 'xdg-config'
$env:XDG_STATE_HOME = Join-Path $root 'xdg-state'
$env:XDG_RUNTIME_DIR = Join-Path $root 'xdg-runtime'
$env:HERDR_APP_HOME = Join-Path $root 'desktop-home'
$env:HC_SESSION = "cou7-win-x64-$env:GITHUB_RUN_ID"
Remove-Item Env:HC_SOCKET, Env:HC_TERMINAL_ID, Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$project = Join-Path $root 'synthetic-project'
$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA, $env:HOME, $env:XDG_CONFIG_HOME, $env:XDG_STATE_HOME, $env:XDG_RUNTIME_DIR, $env:HERDR_APP_HOME, $project, $bin | Out-Null
$env:PATH = "$bin;$env:PATH"
$env:npm_config_script_shell = (Get-Command pwsh).Source
$checks = [ordered]@{ package = 'not_run'; core = 'not_run'; cli = 'not_run'; desktopInput = 'not_run'; ui = 'not_run'; tests = 'not_run' }
$firstFailure = $null
function Fact([string]$stage, [object]$value) {
  @{ stage = $stage; value = $value } | ConvertTo-Json -Depth 12 -Compress | Add-Content -Encoding utf8 $facts
}
function Run([string]$name, [string]$exe, [string[]]$arguments) {
  $out = Join-Path $root "$name.out"; $err = Join-Path $root "$name.err"
  & $exe @arguments 1> $out 2> $err
  $code = $LASTEXITCODE
  Fact $name @{ exit = $code }
  return $code
}
function Must([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Cou7Architecture {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool IsWow64Process2(IntPtr h, out ushort processMachine, out ushort nativeMachine);
}
'@
function PeMachine([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try { $reader = [IO.BinaryReader]::new($stream); $stream.Position = 0x3c; $offset = $reader.ReadUInt32(); $stream.Position = $offset + 4; return $reader.ReadUInt16() }
  finally { $stream.Dispose() }
}
function ProcessMachine($process) {
  try {
    [uint16]$machine = 0; [uint16]$native = 0
    if ([Cou7Architecture]::IsWow64Process2($process.Handle, [ref]$machine, [ref]$native)) {
      return @{ process = ('0x{0:x4}' -f $machine); native = ('0x{0:x4}' -f $native); effective = if ($machine -eq 0) { ('0x{0:x4}' -f $native) } else { ('0x{0:x4}' -f $machine) } }
    }
  } catch { }
  return @{ error = 'process_architecture_unavailable' }
}
try {
  $council = Join-Path $env:GITHUB_WORKSPACE 'council'
  $harness = Join-Path $env:GITHUB_WORKSPACE 'harness'
  $sha = (& git -C $council rev-parse HEAD).Trim()
  $tree = (& git -C $council rev-parse 'HEAD^{tree}').Trim()
  Fact 'revisions' @{ harness = $env:GITHUB_SHA; council = $sha; tree = $tree }
  Must ($sha -eq 'e8974841558641faaa9aecab7386fa7001928137' -and $tree -eq 'd4bc8cc3a97555686c4c16f07e9a07486216b942') 'pinned_checkout_mismatch'
  $node = (Get-Command node).Source
  $nodeInfo = & $node -p 'JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})' | ConvertFrom-Json
  Fact 'runner' @{ image = $env:ImageOS; imageVersion = $env:ImageVersion; osVersion = [Environment]::OSVersion.Version.ToString(); os64 = [Environment]::Is64BitOperatingSystem; powershell64 = [Environment]::Is64BitProcess; node = $nodeInfo }
  Must ($nodeInfo.arch -eq 'x64' -and [Environment]::Is64BitOperatingSystem) 'runner_architecture_mismatch'
  $appUrl = 'https://releases.herdr.dev/app/0.1.18/herdr-app-windows-x86_64.tar.gz'
  $coreUrl = 'https://releases.herdr.dev/core/0.1.22/herdr-core-windows-x86_64.zip'
  $appZip = Join-Path $root 'desktop.tar.gz'; $coreZip = Join-Path $root 'core.zip'
  Invoke-WebRequest -Uri $appUrl -OutFile $appZip
  Invoke-WebRequest -Uri $coreUrl -OutFile $coreZip
  $appHash = (Get-FileHash -Algorithm SHA256 $appZip).Hash.ToLowerInvariant()
  $coreHash = (Get-FileHash -Algorithm SHA256 $coreZip).Hash.ToLowerInvariant()
  Fact 'downloads' @{ desktop = @{ url = $appUrl; expected = 'e6e78e1bec1f47bd0d94dbc872a5670f4ac9c8f6740210b62365ab8b28f897c1'; actual = $appHash }; core = @{ url = $coreUrl; expected = '37cae9d6c522e205efcdb55a42d354285f41b8cbb4c6e60fb505b73b151966c9'; actual = $coreHash } }
  Must ($appHash -eq 'e6e78e1bec1f47bd0d94dbc872a5670f4ac9c8f6740210b62365ab8b28f897c1' -and $coreHash -eq '37cae9d6c522e205efcdb55a42d354285f41b8cbb4c6e60fb505b73b151966c9') 'archive_digest_mismatch'
  & tar -xzf $appZip -C $root
  Must ($LASTEXITCODE -eq 0) 'desktop_extract_failed'
  Expand-Archive -LiteralPath $coreZip -DestinationPath $bin
  $hc = Join-Path $bin 'hc.exe'
  Copy-Item -LiteralPath (Join-Path $bin 'herdr-core.exe') -Destination $hc
  $app = Join-Path $root 'herdr-app/herdr-app.exe'
  $desktopVersion = (& $app --version | Out-String).Trim(); $coreVersion = (& $hc --version | Out-String).Trim()
  Fact 'versions' @{ desktop = $desktopVersion; core = $coreVersion; desktopPeMachine = ('0x{0:x4}' -f (PeMachine $app)); corePeMachine = ('0x{0:x4}' -f (PeMachine $hc)) }
  Must ($desktopVersion -match '0\.1\.18' -and $coreVersion -match '0\.1\.22' -and (PeMachine $app) -eq 0x8664 -and (PeMachine $hc) -eq 0x8664) 'binary_version_or_architecture_mismatch'
  Must ((Run 'hc_skill' $hc @('--skill')) -eq 0) 'hc_skill_unavailable'
  Must ((Run 'desktop_skill' $app @('--skill')) -eq 0) 'desktop_skill_unavailable'
  $inputScript = Join-Path $harness '.github/cou7-windows/input-probe.ps1'
  $inputCode = Run 'input_probe' (Get-Command pwsh).Source @('-NoProfile','-STA','-File',$inputScript)
  if ($inputCode -eq 0) {
    $inputResult = Get-Content -Raw (Join-Path $root 'input_probe.out') | ConvertFrom-Json
    Fact 'input_desktop' $inputResult
    if ($inputResult.nativeInputObserved -and $inputResult.firstFailure -eq $null) { $checks.desktopInput = 'input_probe_pass' }
    else { $checks.desktopInput = 'blocked'; $firstFailure = $inputResult.firstFailure }
  } else { $checks.desktopInput = 'blocked'; $firstFailure = 'native_input_probe_process_failed' }
  Push-Location $council
  try {
    Must ((Run 'npm_pack' 'npm.cmd' @('pack','--pack-destination',$root)) -eq 0) 'npm_pack_failed'
    $packName = (Get-Content (Join-Path $root 'npm_pack.out') | Select-Object -Last 1).Trim()
    $tarball = Join-Path $root $packName
    $tarHash = (Get-FileHash -Algorithm SHA256 $tarball).Hash.ToLowerInvariant()
    Fact 'package_tarball' @{ sha256 = $tarHash }
    Must ((Run 'package_smoke' $node @((Join-Path $council '.github/scripts/package-smoke.mjs'), $tarball)) -eq 0) 'package_smoke_failed'
    Must ((Run 'npm_install' 'npm.cmd' @('install','--prefix',(Join-Path $root 'install'),'--ignore-scripts','--no-audit','--no-fund',$tarball)) -eq 0) 'package_install_failed'
    $pkg = Join-Path $root 'install/node_modules/council-herdr'
    Must ((Run 'installed_cli_help' $node @((Join-Path $pkg 'bin/council.js'),'--help')) -eq 0) 'installed_cli_help_failed'
    Must ((Run 'mod_install' $node @((Join-Path $pkg 'herdr/install.js'),'--app-home',$env:HERDR_APP_HOME)) -eq 0) 'mod_install_failed'
    $mod = Join-Path $env:HERDR_APP_HOME 'mods/council'
    Must (Test-Path -LiteralPath (Join-Path $mod '.council-install.json')) 'mod_receipt_missing'
    $cli = Join-Path $mod 'engine/bin/council.js'
    Must ((Run 'installed_doctor' $node @($cli,'doctor')) -eq 0) 'installed_doctor_failed'
    Must ((Run 'installed_mod_check' $app @('check',$mod)) -eq 0) 'installed_mod_check_failed'
    $checks.package = 'pass'
    # Tests may invoke hc from a short-lived project. Start this isolated core
    # in a stable directory so its working directory cannot pin a test folder.
    Push-Location $root
    try { Must ((Run 'core_start' $hc @('server','start')) -eq 0) 'isolated_core_start_failed' }
    finally { Pop-Location }
    $testCode = Run 'npm_test' 'npm.cmd' @('test')
    $summary = Get-Content (Join-Path $root 'npm_test.out') | Where-Object { $_ -match '^\s*[ℹ#]?\s*(tests|pass|fail|skipped)\s+\d+' } | Select-Object -Last 8
    Fact 'test_summary' @{ exit = $testCode; lines = @($summary) }
    if ($testCode -ne 0) {
      $failedNames = Get-Content (Join-Path $root 'npm_test.out') | Where-Object { $_ -match '^✖ ' } | ForEach-Object { $_ -replace '\s*\([^)]*ms\)$','' } | Select-Object -First 12
      $testLog = Get-Content -Raw (Join-Path $root 'npm_test.out')
      $failureCode = if ($testLog -match "code:\s*'([A-Z][A-Z0-9_]+)'") { $Matches[1] } else { $null }
      $failureCall = if ($testLog -match "syscall:\s*'([a-z0-9]+)'") { $Matches[1] } else { $null }
      Fact 'test_failures' @{ names = @($failedNames); errorCode = $failureCode; syscall = $failureCall }
    }
    $checks.tests = if ($testCode -eq 0) { 'pass' } else { 'fail' }
  } finally { Pop-Location }
  'console.log("COU7_CORE_TRANSPORT_OK")' | Set-Content -Encoding utf8 (Join-Path $root 'core-probe.cjs')
  Must ((Run 'core_status' $hc @('server','status')) -eq 0) 'isolated_core_status_failed'
  $coreStatus = Get-Content -Raw (Join-Path $root 'core_status.out') | ConvertFrom-Json
  Fact 'core_status_sanitized' @{ version = $coreStatus.version; live = $coreStatus.live; finished = $coreStatus.finished }
  $ownCore = @(Get-Process -Name 'hc','herdr-core' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase) })
  Fact 'core_process_architecture' @{ matchingProcessCount = $ownCore.Count; processes = @($ownCore | ForEach-Object { @{ session = $_.SessionId; architecture = (ProcessMachine $_) } }) }
  Must ((Run 'core_run' $hc @('run','--bg','--json','--name','cou7-core-probe','--cwd',$project,'--',$node,(Join-Path $root 'core-probe.cjs'))) -eq 0) 'core_terminal_launch_failed'
  $launch = Get-Content -Raw (Join-Path $root 'core_run.out') | ConvertFrom-Json
  $address = $launch.address
  Must ($address -match '^t[0-9a-z]+$') 'core_terminal_address_missing'
  $waitCode = Run 'core_wait' $hc @('wait','--json',$address,'--timeout','30')
  $wait = Get-Content -Raw (Join-Path $root 'core_wait.out') | ConvertFrom-Json
  $readCode = Run 'core_read' $hc @('read','--lines','5',$address)
  $observed = (Get-Content -Raw (Join-Path $root 'core_read.out')) -match 'COU7_CORE_TRANSPORT_OK'
  Fact 'core_transport' @{ address = $address; waitExit = $waitCode; ended = $wait.ended; reason = $wait.reason; exitCode = $wait.exit_code; markerObserved = $observed; readExit = $readCode }
  Must ($waitCode -eq 0 -and $wait.ended -eq $true -and $wait.reason -eq 'exit' -and $wait.exit_code -eq 0 -and $observed) 'core_transport_incomplete'
  [void](Run 'core_remove_finished' $hc @('rm',$address))
  $checks.core = 'pass'
  $inputFile = Join-Path $root 'input.json'
  @{ id = 'wi-windows-readback'; title = 'Windows native checkpoint'; roleId = 'verifier'; criteria = @('Name the first heading.','Give a concrete next action.') } | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $inputFile
  Push-Location $project
  try {
    Must ((Run 'cli_fixture_role' $node @($cli,'team','set','verifier','--agent','junie','--role','Windows fixture','--permission','read')) -eq 0) 'cli_fixture_role_failed'
    Must ((Run 'cli_create' $node @($cli,'work-item','create','--input-file',$inputFile)) -eq 0) 'cli_create_failed'
    Must ((Run 'cli_show' $node @($cli,'work-item','show','--id','wi-windows-readback')) -eq 0) 'cli_show_failed'
    $item = (Get-Content -Raw (Join-Path $root 'cli_show.out') | ConvertFrom-Json).item
    Fact 'cli_readback' @{ id = $item.id; title = $item.title; roleId = $item.roleId; criteria = $item.criteria; state = $item.state; revision = $item.lifecycle.revision; interface = 'installed_CLI_only_no_dispatch' }
    Must ($item.id -eq 'wi-windows-readback' -and $item.criteria.Count -eq 2 -and $item.roleId -eq 'verifier') 'cli_readback_mismatch'
    $checks.cli = 'pass_readback_only'
  } finally { Pop-Location }
  $appOut = Join-Path $root 'desktop-process.out'; $appErr = Join-Path $root 'desktop-process.err'
  if ($checks.desktopInput -eq 'input_probe_pass') {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $watchReferences = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.TreeScope].Assembly.Location, [System.Runtime.InteropServices.DllImportAttribute].Assembly.Location)
    Add-Type -Path (Join-Path $harness '.github/cou7-windows/window-watch.cs') -ReferencedAssemblies $watchReferences
  }
  $startOptions = @{ FilePath = $app; PassThru = $true; RedirectStandardOutput = $appOut; RedirectStandardError = $appErr }
  if ($checks.desktopInput -ne 'input_probe_pass') { $startOptions.WindowStyle = 'Hidden' }
  $desktop = Start-Process @startOptions
  $idle = $false
  try { $idle = $desktop.WaitForInputIdle(15000) } catch { }
  $desktop.Refresh()
  $appHandle = $desktop.MainWindowHandle
  if (-not $desktop.HasExited -and $checks.desktopInput -eq 'input_probe_pass') {
    $appHandle = [IntPtr][Cou7WindowWatch]::Wait($desktop.Id, 25000)
    $desktop.Refresh()
  }
  $appSession = $null; try { $appSession = $desktop.SessionId } catch { }
  $appFacts = [ordered]@{ pidOwned = $true; session = $appSession; hasExited = $desktop.HasExited; inputIdle = $idle; windowHandlePresent = ($appHandle -ne [IntPtr]::Zero); foreground = $false; visible = $false; uiAutomationMatchesPid = $false; windowWait = 'uia_window_opened_event_bounded' }
  if (-not $desktop.HasExited) { $appFacts.architecture = ProcessMachine $desktop }
  if (-not $desktop.HasExited -and $appFacts.windowHandlePresent) {
    Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Cou7AppWindow {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
    $appFacts.visible = [Cou7AppWindow]::IsWindowVisible($appHandle)
    if ($checks.desktopInput -eq 'input_probe_pass') {
      [void][Cou7AppWindow]::SetForegroundWindow($appHandle)
      $appFacts.foreground = ([Cou7AppWindow]::GetForegroundWindow() -eq $appHandle)
      try { $element = [System.Windows.Automation.AutomationElement]::FromHandle($appHandle); $appFacts.uiAutomationMatchesPid = ($element.Current.ProcessId -eq $desktop.Id) } catch { }
    }
  }
  if ($desktop.HasExited) { $appFacts.exitCode = $desktop.ExitCode }
  Fact 'desktop_process' $appFacts
  if ($checks.desktopInput -eq 'input_probe_pass') {
    if ($appFacts.visible -and $appFacts.foreground -and $appFacts.uiAutomationMatchesPid -and $appFacts.session -eq $inputResult.processSession) {
      $checks.desktopInput = 'pass'; $checks.ui = 'harness_continuation_required'
      [void](Run 'desktop_status' $app @('status'))
      [void](Run 'desktop_internal_shot' $app @('shot',(Join-Path $evidence 'desktop-internal.png')))
    } else {
      $checks.desktopInput = 'blocked'
      $firstFailure = if ($appFacts.hasExited) { 'desktop_process_exited' } elseif (-not $appFacts.windowHandlePresent) { 'desktop_window_not_observed_after_uia_event_wait' } elseif (-not $appFacts.visible) { 'desktop_window_not_visible' } elseif (-not $appFacts.foreground) { 'desktop_window_not_foreground' } else { 'desktop_uia_or_session_mismatch' }
    }
  }
  if ($desktop.HasExited -and -not $firstFailure) { $firstFailure = 'desktop_process_exited' }
} catch {
  if (-not $firstFailure) {
    $message = $_.Exception.Message
    $firstFailure = if ($message -cmatch '^[a-z][a-z0-9_]+$') { $message } else { 'unclassified_harness_exception' }
  }
  Fact 'first_failure' @{ code = $firstFailure; exceptionType = $_.Exception.GetType().Name }
} finally {
  if ($desktop -and -not $desktop.HasExited) { $desktop.CloseMainWindow() | Out-Null }
  $overall = if ($checks.desktopInput -eq 'blocked') { 'blocked_desktop_input' } else { 'incomplete' }
  Fact 'verdict' @{ overall = $overall; firstFailure = $firstFailure; checks = $checks; jobExitIsNotGate = $true }
  @("## COU-7 Windows x64", "", "**Desktop/input: $($checks.desktopInput)**", "", "**UI gate: $($checks.ui)**", "", "**Core: $($checks.core); installed CLI: $($checks.cli)**", "", "Technical job completion is separate from the native gate.") | Add-Content -Encoding utf8 $env:GITHUB_STEP_SUMMARY
}
