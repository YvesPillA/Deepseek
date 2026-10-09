$ErrorActionPreference = 'Stop'
$taskSetupDirectory = Join-Path $PSScriptRoot '..\artifacts\setup'
New-Item -ItemType Directory -Path $taskSetupDirectory -Force | Out-Null
$taskSetupDirectory = (Resolve-Path -LiteralPath $taskSetupDirectory).Path
Start-Transcript -LiteralPath (Join-Path $taskSetupDirectory 'wsl-install.log') -Force
try {
    # Docker's WSL 2 prerequisite only. No Linux user distribution and no reboot.
    $taskFeature = Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart
    $taskWsl = Start-Process -FilePath "$env:SystemRoot\System32\wsl.exe" -ArgumentList '--install','--no-distribution','--web-download' -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $taskSetupDirectory 'wsl-stdout.log') -RedirectStandardError (Join-Path $taskSetupDirectory 'wsl-stderr.log')
    @{featureRestartNeeded=$taskFeature.RestartNeeded;wslExitCode=$taskWsl.ExitCode;finishedAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskSetupDirectory 'wsl-result.json') -Encoding UTF8
} catch {
    @{error=$_.Exception.Message;finishedAt=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskSetupDirectory 'wsl-result.json') -Encoding UTF8
    throw
} finally {Stop-Transcript}
