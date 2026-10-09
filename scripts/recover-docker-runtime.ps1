# Manual workaround for the observed Docker Desktop AF_UNIX error 1920.
# Preserves endpoints; does not reset Docker or remove images/volumes.
$ErrorActionPreference='Stop'
$dockerExecutable=Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
$desktopExecutable=Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'
& $dockerExecutable --host npipe:////./pipe/dockerDesktopLinuxEngine info --format '{{.ServerVersion}}' 2>$null
if($LASTEXITCODE -eq 0) {Write-Output 'Docker is already available; no repair performed';exit 0}
Get-Process | Where-Object ProcessName -Match '^(Docker Desktop|com\.docker\.backend)$' | Stop-Process -Force
$endpointDirs=@((Join-Path $env:LOCALAPPDATA 'Docker\run'),(Join-Path $env:LOCALAPPDATA 'docker-secrets-engine'))
$endpointNames=@('sailor-ingest.sock','sailor-ingest.sock.stale','dockerInference','dockerInference.stale',
  'engine.sock','engine.sock.stale','dockerEthernetVfkit','dockerEthernetVfkit.stale','userAnalyticsOtlpHttp.sock','userAnalyticsOtlpHttp.sock.stale')
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$moves=@()
foreach($endpointDir in $endpointDirs) {
  $resolved=(Resolve-Path -LiteralPath $endpointDir).Path
  if($resolved -ne $endpointDir -or ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Unexpected runtime directory; refusing repair'}
  foreach($child in @(Get-ChildItem -LiteralPath $resolved -Force)) {
    if($child.PSIsContainer -or $child.Length -ne 0 -or !($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $child.Name -notin $endpointNames) {throw 'Unexpected runtime content; refusing directory changes'}
  }
  $backup=$resolved+'.foreman-backup-'+$stamp
  if([IO.Path]::GetDirectoryName($backup) -ne [IO.Path]::GetDirectoryName($resolved) -or (Test-Path -LiteralPath $backup)) {throw 'Invalid backup target'}
  $moves+=@{Source=$resolved;Backup=$backup}
}
foreach($move in $moves) {
  Rename-Item -LiteralPath $move.Source -NewName ([IO.Path]::GetFileName($move.Backup))
  if(!(Test-Path -LiteralPath $move.Source)) {New-Item -ItemType Directory -Path $move.Source | Out-Null}
  Write-Output ('Preserved endpoints: '+$move.Backup)
}
Start-Process -FilePath $desktopExecutable -WindowStyle Hidden
Write-Output 'Docker Desktop launched; verify engine readiness separately.'
