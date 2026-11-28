function Invoke-Cou7Process([string]$exe, [string[]]$arguments, [string]$stdoutPath, [string]$stderrPath, [int]$timeoutMs = 30000) {
  $info=[Diagnostics.ProcessStartInfo]::new()
  $info.FileName=$exe; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  foreach($argument in $arguments) { [void]$info.ArgumentList.Add($argument) }
  $process=[Diagnostics.Process]::Start($info)
  $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($timeoutMs)) {
    $process.Kill(); $process.WaitForExit()
    throw 'owned_cli_process_timeout'
  }
  $encoding=[Text.UTF8Encoding]::new($false)
  [IO.File]::WriteAllText($stdoutPath,$stdout.GetAwaiter().GetResult(),$encoding)
  [IO.File]::WriteAllText($stderrPath,$stderr.GetAwaiter().GetResult(),$encoding)
  return $process.ExitCode
}
