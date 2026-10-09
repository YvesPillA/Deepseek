param([Parameter(Mandatory=$true)][string]$TestRoot,[string]$RuntimeRoot)
$ErrorActionPreference='Stop'
$resolvedTest=(Resolve-Path -LiteralPath $TestRoot).Path
if([IO.Path]::GetDirectoryName($resolvedTest) -ne 'C:\example\foreman-tests' -or [IO.Path]::GetFileName($resolvedTest) -notmatch '^native-ui-smoke-[a-zA-Z0-9_-]+$'){throw 'Invalid isolated test root'}
if((Get-Content -LiteralPath (Join-Path $resolvedTest 'fixture-marker') -Raw) -ne 'isolated-native-ui-test'){throw 'Missing offline fixture marker'}
$priorDshHome=$env:DSH_HOME
$priorDeepSeekKey=$env:DEEPSEEK_API_KEY
$priorRuntime=$env:DSH_RUNTIME_ROOT
. (Join-Path $PSScriptRoot 'select-native-runtime.ps1')
$runtime=Get-NativeDshRuntime $resolvedTest $RuntimeRoot
try {
  $env:DSH_HOME=Join-Path $resolvedTest 'home'
  $env:DEEPSEEK_API_KEY=$null
  $env:DSH_RUNTIME_ROOT=$runtime.root
  & C:\example\dsh\node\node.exe $runtime.cli --profile web --host 127.0.0.1 --port 43822 --no-open
} finally {
  $env:DSH_HOME=$priorDshHome
  $env:DEEPSEEK_API_KEY=$priorDeepSeekKey
  $env:DSH_RUNTIME_ROOT=$priorRuntime
}
