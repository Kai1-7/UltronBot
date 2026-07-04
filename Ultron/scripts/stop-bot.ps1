$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$entryPoint = (Resolve-Path (Join-Path $projectRoot "src\index.js")).Path
$pidFile = Join-Path $projectRoot "bot.pid"

function Get-UltronBotProcess {
  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object {
      $_.CommandLine -like "*$entryPoint*" -or
      $_.CommandLine -like "*src/index.js*" -or
      $_.CommandLine -like "*src\index.js*"
    }
}

$processes = Get-UltronBotProcess

if (-not $processes) {
  if (Test-Path $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
  }

  Write-Host "Ultron Bot ya estaba apagado."
  exit 0
}

foreach ($processInfo in $processes) {
  Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
}

if (Test-Path $pidFile) {
  Remove-Item -LiteralPath $pidFile -Force
}

Write-Host "Ultron Bot apagado."
