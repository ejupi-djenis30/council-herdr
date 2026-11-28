$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $env:GITHUB_WORKSPACE 'harness/.github/cou7-windows/process.ps1')
$root = Join-Path $env:RUNNER_TEMP 'cou7-win-x64'
$evidence = Join-Path $env:RUNNER_TEMP 'cou7-win-evidence'
New-Item -ItemType Directory -Force -Path $root, $evidence | Out-Null
$facts = Join-Path $evidence 'facts.jsonl'
Copy-Item (Join-Path $env:GITHUB_WORKSPACE 'harness/.github/cou7-windows/form-replay.json') (Join-Path $evidence 'offline-form-replay.json')
Copy-Item (Join-Path $env:GITHUB_WORKSPACE 'harness/.github/cou7-windows/process-replay.json') (Join-Path $evidence 'offline-process-replay.json')
Copy-Item (Join-Path $env:GITHUB_WORKSPACE 'harness/.github/cou7-windows/role-replay.json') (Join-Path $evidence 'offline-role-replay.json')
Copy-Item (Join-Path $env:GITHUB_WORKSPACE 'harness/.github/cou7-windows/cli-replay.json') (Join-Path $evidence 'offline-cli-replay.json')
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
  if ($env:COU7_APP -and $exe -eq $env:COU7_APP) {
    $code = Invoke-Cou7Process $exe $arguments $out $err
  } else {
    & $exe @arguments 1> $out 2> $err
    $code = $LASTEXITCODE
  }
  Fact $name @{ exit = $code }
  if ($code -ne 0 -and (Test-Path -LiteralPath $err)) {
    $errorText=Get-Content -Raw -LiteralPath $err
    $category = if ($errorText -match '(?i)unknown argument|invalid argument|usage:') { 'arguments' }
      elseif ($errorText -match '(?i)connection|socket|refused') { 'connection' }
      elseif ($errorText -match '(?i)permission|access denied') { 'permission' }
      elseif ($errorText -match '(?i)renderer|vulkan|gpu|adapter|d3d|dxgi') { 'renderer' }
      elseif ($errorText -match '(?i)timed? ?out') { 'timeout' } else { 'other' }
    $hexCode=if($errorText -match '(?i)\b0x[0-9a-f]{8}\b'){$Matches[0]}else{$null}
    Fact "${name}_error" @{ category=$category; hexCode=$hexCode; stderrPresent=(-not [string]::IsNullOrWhiteSpace($errorText)) }
  }
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
function PeSubsystem([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try { $reader = [IO.BinaryReader]::new($stream); $stream.Position = 0x3c; $offset = $reader.ReadUInt32(); $stream.Position = $offset + 24 + 68; return $reader.ReadUInt16() }
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
  $uiProject = Join-Path $root 'ui-project'
  New-Item -ItemType Directory -Force -Path $uiProject | Out-Null
  Copy-Item (Join-Path $harness '.github/cou7-windows/participant.mjs') (Join-Path $root 'participant.mjs')
  Copy-Item (Join-Path $harness '.github/cou7-windows/fixture-adapter.mjs') (Join-Path $root 'fixture-adapter.mjs')
  $adapterUri = ([Uri](Join-Path $root 'fixture-adapter.mjs')).AbsoluteUri
  $env:NODE_OPTIONS = "--import=$adapterUri"
  $escapedNode = $node.Replace('%','%%'); $escapedFixture = (Join-Path $root 'participant.mjs').Replace('%','%%')
  @('@echo off', '@"%SystemRoot%\System32\chcp.com" 65001 >nul || exit /b 1', "@`"$escapedNode`" `"$escapedFixture`" %*") | Set-Content -Encoding utf8 (Join-Path $bin 'junie.cmd')
  $env:COU7_HARNESS = $harness; $env:COU7_UI_PROJECT = $uiProject; $env:COU7_NODE = $node
  $env:COU7_HC = Join-Path $bin 'hc.exe'
  '# Windows Native Checkpoint' | Set-Content -Encoding utf8 (Join-Path $uiProject 'README.md')
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
  # Windows refreshes PATH for child terminals. Keep the same verified Core
  # executable in the synthetic working directory for native command lookup.
  Copy-Item -LiteralPath $hc -Destination (Join-Path $uiProject 'hc.exe')
  $clientHash = (Get-FileHash -Algorithm SHA256 $hc).Hash.ToLowerInvariant()
  $projectClientHash = (Get-FileHash -Algorithm SHA256 (Join-Path $uiProject 'hc.exe')).Hash.ToLowerInvariant()
  Must ($clientHash -eq $projectClientHash) 'fixture_core_client_mismatch'
  Fact 'fixture_core_resolution' @{ method='project_local_hc_executable'; binarySha256=$clientHash; copiesMatch=$true; registryChanged=$false }
  $app = Join-Path $root 'herdr-app/herdr-app.exe'
  $env:COU7_APP = $app
  $desktopVersion = (& $app --version | Out-String).Trim(); $coreVersion = (& $hc --version | Out-String).Trim()
  Fact 'versions' @{ desktop = $desktopVersion; core = $coreVersion; desktopPeMachine = ('0x{0:x4}' -f (PeMachine $app)); corePeMachine = ('0x{0:x4}' -f (PeMachine $hc)); desktopPeSubsystem=(PeSubsystem $app); corePeSubsystem=(PeSubsystem $hc) }
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
    $env:COU7_CLI = $cli
    Must ((Run 'installed_doctor' $node @($cli,'doctor')) -eq 0) 'installed_doctor_failed'
    Must ((Run 'installed_mod_check' $app @('check',$mod)) -eq 0) 'installed_mod_check_failed'
    $checks.package = 'pass'
    # Tests may invoke hc from a short-lived project. Start this isolated core
    # in a stable directory so its working directory cannot pin a test folder.
    Push-Location $root
    try { Must ((Run 'core_start' $hc @('server','start')) -eq 0) 'isolated_core_start_failed' }
    finally { Pop-Location }
    $nodeOptions = $env:NODE_OPTIONS
    try { $env:NODE_OPTIONS = ''; $testCode = Run 'npm_test' 'npm.cmd' @('test') }
    finally { $env:NODE_OPTIONS = $nodeOptions }
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
  Push-Location $uiProject
  try { Must ((Run 'cli_ui_fixture_role' $node @($cli,'team','set','verifier','--agent','junie','--role','Windows fixture','--permission','read')) -eq 0) 'cli_ui_fixture_role_failed' }
  finally { Pop-Location }
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
      Fact 'desktop_internal_shot_file' @{ exists = (Test-Path -LiteralPath (Join-Path $evidence 'desktop-internal.png')); note = 'internal_capture_alone_is_not_input_proof' }
      $env:COU7_WINDOW_HANDLE = $appHandle.ToInt64().ToString(); $env:COU7_APP_PID = $desktop.Id.ToString()
      $uiScript = Join-Path $harness '.github/cou7-windows/ui.ps1'
      [void](Run 'ui_initial_capture' (Get-Command pwsh).Source @('-NoProfile','-STA','-File',$uiScript,'-Mode','capture'))
      Get-Content (Join-Path $root 'ui_initial_capture.out') | Add-Content -Encoding utf8 $facts
      $spaceCode = Run 'desktop_space_new' $app @('do','space.new','--name','COU7 x64 test','--folder',$uiProject,'--argv','["cmd.exe","/k"]')
      Must ($spaceCode -eq 0) 'desktop_space_new_failed'
      $space = Get-Content -Raw (Join-Path $root 'desktop_space_new.out') | ConvertFrom-Json
      Fact 'project_terminal' @{ interface='Desktop_command'; address=$space.terminal; note='project_terminal_left_to_runner_teardown' }
      Must ((Run 'desktop_mod_open' $app @('do','mod.open','--name','council')) -eq 0) 'desktop_mod_open_failed'
      $uiCode = Run 'ui_create' (Get-Command pwsh).Source @('-NoProfile','-STA','-File',$uiScript,'-Mode','create')
      Get-Content (Join-Path $root 'ui_create.out') | Add-Content -Encoding utf8 $facts
      Fact 'ui_create_exit' @{ exit=$uiCode; saveAttempted=(Test-Path (Join-Path $root 'ui-save-attempted')); delegateAttempted=(Test-Path (Join-Path $root 'ui-delegate-attempted')) }
      if ($uiCode -ne 0 -and -not $firstFailure) { $firstFailure='ui_create_incomplete' }
      $deliveryCode = $null
      if (Test-Path -LiteralPath (Join-Path $root 'ui-delegate-attempted')) {
        $deliveryCode = Run 'ui_collect' (Get-Command pwsh).Source @('-NoProfile','-File',(Join-Path $harness '.github/cou7-windows/collect.ps1'))
        Get-Content (Join-Path $root 'ui_collect.out') | Add-Content -Encoding utf8 $facts
        Fact 'ui_collect_exit' @{ exit=$deliveryCode; noResend=$true }
        if ($deliveryCode -eq 0) { $checks.core='pass_real_delivery'; $checks.cli='pass_ui_readback' }
        else {
          if (-not $firstFailure) { $firstFailure='ui_delivery_observation_incomplete' }
          $createdPath=Join-Path $root 'ui-created.json'
          if (Test-Path -LiteralPath $createdPath) {
            $created=Get-Content -Raw $createdPath | ConvertFrom-Json
            Push-Location $uiProject
            try {
              if ((Run 'ui_uncertain_show' $node @($cli,'work-item','show','--id',$created.id)) -eq 0) {
                $savedItem=(Get-Content -Raw (Join-Path $root 'ui_uncertain_show.out') | ConvertFrom-Json).item
                Fact 'ui_uncertain_item' @{ interface='installed_CLI_readonly'; id=$savedItem.id; state=$savedItem.state; revision=$savedItem.lifecycle.revision; job=$savedItem.job; noResend=$true }
                if ($savedItem.job.sessionId -and (Run 'ui_uncertain_job' $node @($cli,'status','--session',$savedItem.job.sessionId)) -eq 0) {
                  $savedJob=Get-Content -Raw (Join-Path $root 'ui_uncertain_job.out') | ConvertFrom-Json
                  Fact 'ui_uncertain_job' @{ interface='installed_CLI_readonly'; sessionId=$savedJob.sessionId; state=$savedJob.state; deliveryState=$savedJob.deliveryState; participantAddress=$savedJob.participant.address; power=$savedJob.participant.power; workerAddress=$savedJob.worker.address }
                }
              }
            } finally { Pop-Location }
          }
          if ((Run 'ui_uncertain_core_list' $hc @('ls','--all','--json')) -eq 0) {
            $owned=Get-Content -Raw (Join-Path $root 'ui_uncertain_core_list.out') | ConvertFrom-Json
            Fact 'ui_uncertain_core_list' @{ interface='isolated_Core_readonly'; terminals=@($owned.terminals | ForEach-Object { @{ address=$_.address; state=$_.state; turn=$_.turn; status=$_.status.state } }) }
          }
        }
      } elseif (Test-Path -LiteralPath (Join-Path $root 'ui-save-attempted')) {
        Fact 'ui_reconciliation' @{ interface='installed_CLI_readonly'; mode='no_redispatch'; note='save_may_have_been_accepted' }
        Push-Location $uiProject
        try {
          if ((Run 'ui_uncertain_list' $node @($cli,'work-item','list')) -eq 0) {
            $list = Get-Content -Raw (Join-Path $root 'ui_uncertain_list.out') | ConvertFrom-Json
            Fact 'ui_uncertain_list' @{ items=@($list.items | ForEach-Object { @{ id=$_.id; title=$_.title; roleId=$_.roleId; state=$_.state } }) }
            $matchingItems=@($list.items | Where-Object title -eq 'Windows native checkpoint')
            if ($matchingItems.Count -eq 1 -and (Run 'ui_uncertain_show' $node @($cli,'work-item','show','--id',$matchingItems[0].id)) -eq 0) {
              $savedItem=(Get-Content -Raw (Join-Path $root 'ui_uncertain_show.out') | ConvertFrom-Json).item
              Fact 'ui_uncertain_item' @{ interface='installed_CLI_readonly'; id=$savedItem.id; title=$savedItem.title; criteria=$savedItem.criteria; roleId=$savedItem.roleId; state=$savedItem.state; revision=$savedItem.lifecycle.revision; job=$savedItem.job; noResend=$true }
            }
          }
        } finally { Pop-Location }
      }
      if ($uiCode -eq 0 -and $deliveryCode -eq 0) {
        Must ((Run 'overlay_before' $app @('status')) -eq 0) 'overlay_before_status_failed'
        $before=(Get-Content -Raw (Join-Path $root 'overlay_before.out') | ConvertFrom-Json).overlays
        Must ('council' -in @($before)) 'overlay_before_not_observed'
        Must ((Run 'overlay_close_command' $app @('do','mod.open','--name','council')) -eq 0) 'overlay_close_command_failed'
        Must ((Run 'overlay_closed' $app @('status')) -eq 0) 'overlay_closed_status_failed'
        $closed=(Get-Content -Raw (Join-Path $root 'overlay_closed.out') | ConvertFrom-Json).overlays
        Must ('council' -notin @($closed)) 'overlay_close_not_observed'
        Must ((Run 'overlay_open_command' $app @('do','mod.open','--name','council')) -eq 0) 'overlay_open_command_failed'
        Must ((Run 'overlay_reopened' $app @('status')) -eq 0) 'overlay_reopened_status_failed'
        $reopened=(Get-Content -Raw (Join-Path $root 'overlay_reopened.out') | ConvertFrom-Json).overlays
        Must ('council' -in @($reopened)) 'overlay_reopen_not_observed'
        Fact 'overlay_transition' @{ interface='Desktop_command_status'; before=$true; closed=$false; reopened=$true }
        $reopenCode = Run 'ui_reopen' (Get-Command pwsh).Source @('-NoProfile','-STA','-File',$uiScript,'-Mode','reopen')
        Get-Content (Join-Path $root 'ui_reopen.out') | Add-Content -Encoding utf8 $facts
        Fact 'ui_reopen_exit' @{ exit=$reopenCode }
        $records = @(Get-Content $facts | ForEach-Object { try { $_ | ConvertFrom-Json } catch { } })
        $saveCount=@($records | Where-Object { $_.stage -eq 'ui_mutation_attempted' -and $_.value.name -eq 'save' }).Count
        $delegateCount=@($records | Where-Object { $_.stage -eq 'ui_mutation_attempted' -and $_.value.name -eq 'delegate' }).Count
        $content=@($records | Where-Object { $_.stage -eq 'ui_handoff_content' -and $_.value.heading -and $_.value.outputNext -and $_.value.guidance }).Count -eq 1
        $sessionMatch=@($records | Where-Object { $_.stage -eq 'ui_session_match' -and $_.value.match }).Count -eq 1
        Fact 'ui_gate_evidence' @{ saveGestures=$saveCount; delegateGestures=$delegateCount; handoffContent=$content; sessionMatch=$sessionMatch }
        if ($reopenCode -eq 0 -and $saveCount -eq 1 -and $delegateCount -eq 1 -and $content -and $sessionMatch) { $checks.ui='pass' } else { $checks.ui='incomplete_reopen'; if (-not $firstFailure) { $firstFailure='ui_reopen_incomplete' } }
      } else { $checks.ui='incomplete_create_or_delivery' }
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
  $overall = if ($checks.desktopInput -eq 'blocked') { 'blocked_desktop_input' } elseif ($checks.ui -eq 'pass' -and $checks.package -eq 'pass' -and $checks.tests -eq 'pass' -and $checks.core -eq 'pass_real_delivery') { 'pass' } else { 'incomplete' }
  Fact 'verdict' @{ overall = $overall; firstFailure = $firstFailure; checks = $checks; jobExitIsNotGate = $true }
  @("## COU-7 Windows x64", "", "**Desktop/input: $($checks.desktopInput)**", "", "**UI gate: $($checks.ui)**", "", "**Core: $($checks.core); installed CLI: $($checks.cli)**", "", "Technical job completion is separate from the native gate.") | Add-Content -Encoding utf8 $env:GITHUB_STEP_SUMMARY
}
