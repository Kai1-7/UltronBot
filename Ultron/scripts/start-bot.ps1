$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$entryPoint = (Resolve-Path (Join-Path $projectRoot "src\index.js")).Path
$logDir = Join-Path $projectRoot "logs"
$pidFile = Join-Path $projectRoot "bot.pid"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-UltronBotProcess {
  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object {
      $_.CommandLine -like "*$entryPoint*" -or
      $_.CommandLine -like "*src/index.js*" -or
      $_.CommandLine -like "*src\index.js*"
    }
}

$existing = Get-UltronBotProcess
if ($existing) {
  foreach ($processInfo in $existing) {
    try {
      $process = Get-Process -Id $processInfo.ProcessId -ErrorAction Stop
      $process.PriorityClass = "AboveNormal"
      $process.Id | Set-Content -Path $pidFile -Encoding ascii
    } catch {}
  }

  Write-Host "Ultron Bot ya estaba encendido. Prioridad ajustada a AboveNormal."
  exit 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$stdout = Join-Path $logDir "bot-$stamp.out.log"
$stderr = Join-Path $logDir "bot-$stamp.err.log"
$nodePath = (Get-Command node.exe).Source

$env:UV_THREADPOOL_SIZE = "2"
$env:NODE_ENV = "production"

$process = Start-Process `
  -FilePath $nodePath `
  -ArgumentList "`"$entryPoint`"" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

Start-Sleep -Seconds 1

try {
  $process.PriorityClass = "AboveNormal"
} catch {}

$process.Id | Set-Content -Path $pidFile -Encoding ascii

Write-Host "Ultron Bot encendido con prioridad AboveNormal."
Write-Host "PID: $($process.Id)"
Write-Host "Log: $stdout"
