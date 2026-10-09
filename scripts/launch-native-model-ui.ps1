param([Parameter(Mandatory=$true)][string]$TestRoot,[Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]{1,60}$')][string]$Batch,[string]$RuntimeRoot,[string]$ModelProfilePatch,[switch]$Fresh)
$ErrorActionPreference='Stop'
$resolvedTest=(Resolve-Path -LiteralPath $TestRoot).Path
if([IO.Path]::GetDirectoryName($resolvedTest) -ne 'C:\example\foreman-tests' -or [IO.Path]::GetFileName($resolvedTest) -notmatch '^native-model-ui-[a-zA-Z0-9_-]+$'){throw 'Invalid isolated test root'}
$marker=Get-Content -LiteralPath (Join-Path $resolvedTest 'fixture-marker') -Raw
if($marker -notin @('authorized-native-model-ui-40-4096-600000','prepared-native-model-ui','prepared-fresh-native-model-ui-v2')){throw 'Missing fixture marker'}
if($Fresh -and $marker -ne 'prepared-fresh-native-model-ui-v2'){throw 'Explicit fresh fixture marker required'}
. (Join-Path $PSScriptRoot 'select-native-runtime.ps1')
$runtime=Get-NativeDshRuntime $resolvedTest $RuntimeRoot
$authPath=Join-Path $resolvedTest ("run-authorization-$Batch.json")
$auth=Get-Content -LiteralPath $authPath -Raw | ConvertFrom-Json
$now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
if($auth.fixtureRoot -cne $resolvedTest -or $auth.batch -cne $Batch -or $auth.projectId -cne 'chat' -or
   $auth.workspace -cne (Join-Path $resolvedTest 'work') -or $auth.endpoint -cne 'https://api.deepseek.com/anthropic/v1/messages' -or
   $auth.credentialRef -cne 'DEEPSEEK_API_KEY' -or $auth.maxRequests -ne 40 -or $auth.maxOutputTokens -ne 4096 -or
   $auth.issuedAt -gt $now -or $auth.expiresAt -le $now -or ($auth.expiresAt-$auth.issuedAt) -gt 600000 -or
   ($auth.expiresAt-$auth.issuedAt) -lt 1){throw 'Fresh bounded authorization required'}
$priorRuntime=$env:DSH_RUNTIME_ROOT
$priorProfilePatch=$env:DSH_MODEL_PROFILE_PATCH
$priorEntry=$env:FOREMAN_UI_ENTRY
$env:DSH_RUNTIME_ROOT=$runtime.root
$entryMode='--resume'
if($Fresh){$entryMode='--fresh';$env:FOREMAN_UI_ENTRY='fresh'}else{$env:FOREMAN_UI_ENTRY='resume'}
if($ModelProfilePatch){$env:DSH_MODEL_PROFILE_PATCH=$ModelProfilePatch}
try {
& C:\example\dsh\node\node.exe (Join-Path $PSScriptRoot 'preflight-native-model-ui.mjs') $resolvedTest $Batch $entryMode
if($LASTEXITCODE -ne 0){throw 'Read-only project and batch preflight failed'}
if(Test-Path -LiteralPath (Join-Path $resolvedTest 'journal/state.jsonl')){
  & C:\example\dsh\node\node.exe (Join-Path $PSScriptRoot 'prepare-native-model-ui.mjs') --resume $resolvedTest
  if($LASTEXITCODE -ne 0){throw 'Fixture profile preparation failed'}
}
$priorModelSecret=$env:DEEPSEEK_API_KEY
$priorDshHome=$env:DSH_HOME
$priorBatch=$env:FOREMAN_UI_BATCH
$priorLauncher=$env:FOREMAN_UI_LAUNCHER
try {
  $launcherText=Get-Content -LiteralPath 'C:\example\dsh\launch.cmd' -Raw
  $secretMatch=[regex]::Match($launcherText,'(?mi)^\s*@?set\s+"?DEEPSEEK_API_KEY=([^\r\n]*)$')
  if(!$secretMatch.Success){throw 'Approved credential not found'}
  $env:DEEPSEEK_API_KEY=$secretMatch.Groups[1].Value.Trim().TrimEnd('"')
  if($env:DEEPSEEK_API_KEY -match '[%\r\n]'){throw 'Invalid credential source'}
  $launcherText=$null;$secretMatch=$null
  $env:DSH_HOME=Join-Path $resolvedTest 'home'
  $env:FOREMAN_UI_BATCH=$Batch
  $env:FOREMAN_UI_LAUNCHER='C:\example\dsh\launch.cmd'
  & C:\example\dsh\node\node.exe $runtime.cli --profile web --host 127.0.0.1 --port 43822 --no-open
} finally {$env:DEEPSEEK_API_KEY=$priorModelSecret;$env:DSH_HOME=$priorDshHome;$env:FOREMAN_UI_BATCH=$priorBatch;$env:FOREMAN_UI_LAUNCHER=$priorLauncher}
} finally {$env:DSH_RUNTIME_ROOT=$priorRuntime;$env:DSH_MODEL_PROFILE_PATCH=$priorProfilePatch;$env:FOREMAN_UI_ENTRY=$priorEntry}
