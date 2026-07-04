param(
  [string]$BackupPath
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $projectRoot "logs"

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not $BackupPath) {
  $BackupPath = Get-ChildItem -Path $logDir -Filter "ethernet-advanced-before-*.csv" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $BackupPath -or -not (Test-Path $BackupPath)) {
  throw "No encontre un backup de configuracion Ethernet para restaurar."
}

if (-not (Test-IsAdmin)) {
  $arguments = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`"",
    "-BackupPath", "`"$BackupPath`""
  )

  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait
  exit
}

$entries = Import-Csv -Path $BackupPath

foreach ($entry in $entries) {
  Set-NetAdapterAdvancedProperty `
    -Name $entry.Name `
    -DisplayName $entry.DisplayName `
    -DisplayValue $entry.DisplayValue `
    -NoRestart
}

$adapterNames = $entries | Select-Object -ExpandProperty Name -Unique

foreach ($adapterName in $adapterNames) {
  Restart-NetAdapter -Name $adapterName -Confirm:$false
}

Write-Host "Configuracion Ethernet restaurada desde: $BackupPath"
