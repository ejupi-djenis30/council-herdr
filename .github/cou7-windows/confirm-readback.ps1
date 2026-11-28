function Test-Cou7ConfirmReadback($item,[string]$expectedId) {
  return ($null -ne $item -and $item.id -eq $expectedId -and $null -ne $item.job -and
          $item.job.linked -eq $true -and $item.job.sessionId -cmatch '^wi-job-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
}
