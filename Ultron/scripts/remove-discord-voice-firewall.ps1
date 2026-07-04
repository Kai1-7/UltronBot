$ErrorActionPreference = "Stop"

$rulePrefix = "Ultron Voice"

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

$rules = Get-NetFirewallRule -DisplayName "$rulePrefix*" -ErrorAction SilentlyContinue

if (-not $rules) {
  Write-Host "No hay reglas '$rulePrefix' para eliminar."
  exit 0
}

$rules | Remove-NetFirewallRule
Write-Host "Reglas '$rulePrefix' eliminadas."
