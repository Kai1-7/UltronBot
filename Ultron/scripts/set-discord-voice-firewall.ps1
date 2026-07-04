$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $projectRoot "logs"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "discord-voice-firewall-$stamp.log"
$backupPath = Join-Path $logDir "discord-voice-firewall-before-$stamp.json"
$rulePrefix = "Ultron Voice"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-DiscordPath {
  $process = Get-Process Discord -ErrorAction SilentlyContinue |
    Where-Object { $_.Path } |
    Select-Object -First 1

  if ($process) {
    return $process.Path
  }

  $discord = Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Discord") -Filter "Discord.exe" -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($discord) {
    return $discord.FullName
  }

  return $null
}

function Add-ProgramRule {
  param(
    [string]$DisplayName,
    [string]$Program,
    [string]$Direction,
    [string]$Protocol,
    [string]$Profile
  )

  New-NetFirewallRule `
    -DisplayName $DisplayName `
    -Group "Ultron Bot" `
    -Program $Program `
    -Direction $Direction `
    -Action Allow `
    -Protocol $Protocol `
    -Profile $Profile `
    -EdgeTraversalPolicy Block | Out-Null

  Write-Host "Regla creada: $DisplayName"
}

if (-not (Test-IsAdmin)) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`""
  )

  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait
  exit
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Transcript -Path $logPath -Force | Out-Null

try {
  $nodePath = (Get-Command node.exe).Source
  $discordPath = Get-DiscordPath

  if (-not $nodePath) {
    throw "No encontre node.exe."
  }

  $existingRules = Get-NetFirewallRule -DisplayName "$rulePrefix*" -ErrorAction SilentlyContinue
  $existingRules |
    Select-Object DisplayName,Enabled,Direction,Action,Profile,InstanceID |
    ConvertTo-Json -Depth 4 |
    Set-Content -Path $backupPath -Encoding utf8

  if ($existingRules) {
    $existingRules | Remove-NetFirewallRule
    Write-Host "Reglas anteriores de Ultron Voice eliminadas para recrearlas limpias."
  }

  Write-Host "Node: $nodePath"
  Add-ProgramRule "$rulePrefix - Bot UDP Out" $nodePath Outbound UDP Any
  Add-ProgramRule "$rulePrefix - Bot TCP Out" $nodePath Outbound TCP Any
  Add-ProgramRule "$rulePrefix - Bot UDP In Private" $nodePath Inbound UDP Private

  if ($discordPath) {
    Write-Host "Discord: $discordPath"
    Add-ProgramRule "$rulePrefix - Discord UDP Out" $discordPath Outbound UDP Any
    Add-ProgramRule "$rulePrefix - Discord TCP Out" $discordPath Outbound TCP Any
    Add-ProgramRule "$rulePrefix - Discord UDP In Private" $discordPath Inbound UDP Private
  } else {
    Write-Host "No encontre Discord.exe; solo cree reglas para el bot."
  }

  Get-NetFirewallRule -DisplayName "$rulePrefix*" |
    Select-Object DisplayName,Enabled,Direction,Action,Profile |
    Sort-Object DisplayName |
    Format-Table -AutoSize

  Write-Host "Backup: $backupPath"
} finally {
  Stop-Transcript | Out-Null
}
