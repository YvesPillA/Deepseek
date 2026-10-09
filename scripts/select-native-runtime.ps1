# Resolve the same runtime used while preparing the isolated fixture. No npm.
function Get-NativeDshRuntime([string]$FixtureRoot,[string]$RequestedRoot) {
  $recordPath=Join-Path $FixtureRoot 'fixture-runtime.json'
  $record=$null
  if(Test-Path -LiteralPath $recordPath){$record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json}
  if(!$RequestedRoot){$RequestedRoot=$env:DSH_RUNTIME_ROOT}
  if(!$RequestedRoot -and $record){$RequestedRoot=$record.root}
  if(!$RequestedRoot){$RequestedRoot='C:/example/dsh/node/node_modules/@deepseek-ai/dsh'}
  $resolvedRuntime=(Resolve-Path -LiteralPath $RequestedRoot).Path
  if($record -and (Resolve-Path -LiteralPath $record.root).Path -ne $resolvedRuntime){throw 'Prepared fixture runtime does not match requested launch runtime'}
  $priorRuntime=$env:DSH_RUNTIME_ROOT
  try {
    $env:DSH_RUNTIME_ROOT=$resolvedRuntime
    $selected=& C:\example\dsh\node\node.exe (Join-Path $PSScriptRoot 'dsh-runtime.mjs')
    if($LASTEXITCODE -ne 0){throw 'Runtime resolution failed'}
    return ($selected | ConvertFrom-Json)
  } finally {$env:DSH_RUNTIME_ROOT=$priorRuntime}
}
