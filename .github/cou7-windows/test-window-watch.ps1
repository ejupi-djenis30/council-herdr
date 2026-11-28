param([Parameter(Mandatory=$true)][string]$Facts)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$refs = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.TreeScope].Assembly.Location, [System.Runtime.InteropServices.DllImportAttribute].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot 'window-watch.cs') -ReferencedAssemblies $refs
$records = Get-Content $Facts | ForEach-Object { $_ | ConvertFrom-Json }
$inputResult = ($records | Where-Object stage -eq 'input_desktop').value
$appResult = ($records | Where-Object stage -eq 'desktop_process').value
if (-not ($inputResult.nativeInputObserved -and $appResult.inputIdle -and -not $appResult.hasExited -and -not $appResult.windowHandlePresent)) {
  throw 'saved frame does not reproduce the immediate observation failure'
}
if ([Cou7WindowWatch]::Eligible(17,18,100,$true)) { throw 'foreign process accepted' }
if ([Cou7WindowWatch]::Eligible(17,17,0,$true)) { throw 'empty handle accepted' }
if ([Cou7WindowWatch]::Eligible(17,17,100,$false)) { throw 'hidden window accepted' }
if (-not [Cou7WindowWatch]::Eligible(17,17,100,$true)) { throw 'visible owned event rejected' }
@{ sourceRun = 'https://github.com/Ejupi-Labs/council-herdr/actions/runs/46179430717'; observedInput = 'passed';
   observedImmediateWindow = 'absent_while_process_alive'; syntheticEligibleEvent = 'accepted';
   foreignHiddenEmptyEvents = 'rejected'; limitation = 'No actual window arrival is inferred from the saved snapshot; event values are synthetic.' } | ConvertTo-Json -Compress
