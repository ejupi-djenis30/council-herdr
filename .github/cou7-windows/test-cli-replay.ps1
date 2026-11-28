param([Parameter(Mandatory=$true)][string]$Project,[Parameter(Mandatory=$true)][string]$CouncilCli)
$ErrorActionPreference='Stop'
$path=Join-Path $PSScriptRoot 'ui.ps1';$parseErrors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw 'ui_script_parse_failed' }
$definitions=@($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Read-Cou7WorkItem' },$true))
if ($definitions.Count -ne 1) { throw 'readback_helper_not_unique' }
Invoke-Expression $definitions[0].Extent.Text
$env:COU7_UI_PROJECT=$Project; $env:COU7_CLI=$CouncilCli; $env:COU7_NODE=(Get-Command node).Source
if ((Get-Alias cli).Definition -ne 'Clear-Item') { throw 'original_alias_not_reproduced' }
$items=@((Read-Cou7WorkItem @('list')).items | Where-Object title -eq 'Windows native checkpoint')
if ($items.Count -ne 1) { throw 'replay_item_not_unique' }
$item=(Read-Cou7WorkItem @('show','--id',$items[0].id)).item
if ($item.roleId -ne 'verifier' -or $item.criteria.Count -ne 2) { throw 'replay_detail_mismatch' }
@{ sourceRun='https://github.com/Ejupi-Labs/council-herdr/actions/runs/46182656492';
   originalNameResolvesTo='Clear-Item_alias'; correctedReadback='actual_CLI_list_and_show_pass';
   role=$item.roleId; criteriaCount=$item.criteria.Count; noDispatch=$true;
   limitation='Readback replay used a separate synthetic local project; it did not repeat the UI mutation.' } | ConvertTo-Json -Compress
