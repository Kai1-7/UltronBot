$ErrorActionPreference = "Stop"

$adapter = "Ethernet"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $projectRoot "logs"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "ethernet-low-latency-$stamp.log"
$backupPath = Join-Path $logDir "ethernet-advanced-before-$stamp.csv"
$targetProps = @(
  "Energy-Efficient Ethernet",
  "Green Ethernet",
  "Power Saving Mode",
  "Interrupt Moderation"
)

function Test-IsAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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
  Write-Host "Adapter: $adapter"
  Write-Host "Backup: $backupPath"

  Get-NetAdapterAdvancedProperty -Name $adapter |
    Where-Object { $targetProps -contains $_.DisplayName } |
    Select-Object Name,DisplayName,DisplayValue,RegistryKeyword,RegistryValue |
    Export-Csv -Path $backupPath -NoTypeInformation

  foreach ($displayName in $targetProps) {
    try {
      Set-NetAdapterAdvancedProperty -Name $adapter -DisplayName $displayName -DisplayValue "Disabled" -NoRestart -ErrorAction Stop
      Write-Host "Disabled: $displayName"
    } catch {
      Write-Host "No pude cambiar '$displayName': $($_.Exception.Message)"
    }
  }

  Restart-NetAdapter -Name $adapter -Confirm:$false
  Start-Sleep -Seconds 6

  Get-NetAdapterAdvancedProperty -Name $adapter |
    Where-Object { $targetProps -contains $_.DisplayName } |
    Select-Object DisplayName,DisplayValue |
    Format-Table -AutoSize
} finally {
  Stop-Transcript | Out-Null
}
