param(
  [Parameter(Mandatory = $true)][string]$UbuntuPublicKey,
  [string]$UbuntuHost = '192.168.3.176',
  [string]$Root = "$HOME\.jeff-deploy"
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run once from an elevated PowerShell window.'
}
if ($UbuntuHost -ne '192.168.3.176' -or $UbuntuPublicKey -notmatch '^ssh-(ed25519|rsa)\s+') { throw 'Unexpected Ubuntu address or invalid SSH public key.' }

$capability = Get-WindowsCapability -Online | Where-Object Name -eq 'OpenSSH.Server~~~~0.0.1.0'
if ($capability.State -ne 'Installed') { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }
Set-Service sshd -StartupType Automatic
Start-Service sshd
$rule = Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue
if (-not $rule) {
  New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName 'OpenSSH Server (Jeff deploy from Ubuntu)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress $UbuntuHost | Out-Null
} else {
  Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -RemoteAddress $UbuntuHost
}

$sshDir = Join-Path $HOME '.ssh'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$authorizedKeys = if ($admin) { Join-Path $env:ProgramData 'ssh\administrators_authorized_keys' } else { Join-Path $sshDir 'authorized_keys' }
New-Item -ItemType Directory -Force -Path (Split-Path $authorizedKeys -Parent) | Out-Null
if (-not (Test-Path $authorizedKeys) -or -not (Select-String -Path $authorizedKeys -SimpleMatch $UbuntuPublicKey -Quiet)) {
  Add-Content -Path $authorizedKeys -Value $UbuntuPublicKey -Encoding ascii
}
if ($admin) {
  icacls $authorizedKeys /inheritance:r /grant:r 'SYSTEM:F' 'BUILTIN\Administrators:F' | Out-Null
} else {
  icacls $sshDir /inheritance:r /grant:r "$($account):(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
  icacls $authorizedKeys /inheritance:r /grant:r "$($account):F" 'SYSTEM:F' | Out-Null
}

New-Item -ItemType Directory -Force -Path "$Root\incoming", "$Root\results", "$Root\install-requests" | Out-Null
$worker = Join-Path $PSScriptRoot 'Worker.ps1'
Copy-Item $worker (Join-Path $Root 'Worker.ps1') -Force
Copy-Item (Join-Path $PSScriptRoot 'Install-Jeff.ps1') (Join-Path $Root 'Install-Jeff.ps1') -Force
Copy-Item (Join-Path $PSScriptRoot 'desktop-runner.cjs') (Join-Path $Root 'desktop-runner.cjs') -Force
$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node -e "require('playwright')" 2>$null
if ($LASTEXITCODE -ne 0) { & npm.cmd install --prefix $Root playwright@1.63.0; if ($LASTEXITCODE -ne 0) { throw 'Could not install the Windows Playwright runner.' } }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\Worker.ps1`" -Root `"$Root`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'JeffDeployWorker' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'JeffDeployWorker'
$installAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\Install-Jeff.ps1`" -Root `"$Root`""
$installPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName 'JeffDeployInstaller' -Action $installAction -Trigger $trigger -Principal $installPrincipal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'JeffDeployInstaller'

$fingerprint = (ssh-keygen.exe -lf "$env:ProgramData\ssh\ssh_host_ed25519_key.pub" -E sha256 2>$null | Out-String).Trim()
Write-Host "Jeff deploy worker configured for $env:USERNAME."
Write-Host "SSH host key: $fingerprint"
Write-Host "Ubuntu must pin this fingerprint before its first connection."
