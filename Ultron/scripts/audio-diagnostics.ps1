param(
  [int]$Seconds = 120,
  [int]$IntervalSeconds = 2
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$entryPoint = (Resolve-Path (Join-Path $projectRoot "src\index.js")).Path
$logDir = Join-Path $projectRoot "logs"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputPath = Join-Path $logDir "audio-diagnostics-$stamp.csv"
$logicalProcessors = [Environment]::ProcessorCount

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Get-UltronBotPid {
  $processInfo = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object {
      $_.CommandLine -like "*$entryPoint*" -or
      $_.CommandLine -like "*src/index.js*" -or
      $_.CommandLine -like "*src\index.js*"
    } |
    Select-Object -First 1

  if ($processInfo) {
    return [int]$processInfo.ProcessId
  }

  return $null
}

function Get-DiscordCpuSeconds {
  $discord = Get-Process Discord -ErrorAction SilentlyContinue
  if (-not $discord) {
    return 0
  }

  return ($discord | Measure-Object -Property CPU -Sum).Sum
}

function Get-ProcessCpuPercent {
  param(
    [double]$CurrentCpuSeconds,
    [object]$PreviousCpuSeconds,
    [double]$ElapsedSeconds
  )

  if ($null -eq $PreviousCpuSeconds -or $ElapsedSeconds -le 0) {
    return $null
  }

  return [Math]::Round((($CurrentCpuSeconds - $PreviousCpuSeconds) / $ElapsedSeconds / $logicalProcessors) * 100, 2)
}

function Get-DeltaRate {
  param(
    [object]$CurrentValue,
    [object]$PreviousValue,
    [double]$ElapsedSeconds
  )

  if ($null -eq $CurrentValue -or $null -eq $PreviousValue -or $ElapsedSeconds -le 0) {
    return $null
  }

  return [Math]::Round((([double]$CurrentValue - [double]$PreviousValue) / $ElapsedSeconds), 2)
}

Write-Host "Guardando diagnostico en: $outputPath"
Write-Host "Abre una cancion y, si quieres probar el caso real, abre el juego durante estos $Seconds segundos."

$botPid = Get-UltronBotPid
$previousTime = Get-Date
$previousBotCpu = $null
$previousDiscordCpu = $null
$previousVoicePackets = $null
$endAt = (Get-Date).AddSeconds($Seconds)

while ((Get-Date) -lt $endAt) {
  $now = Get-Date
  $elapsedSeconds = ($now - $previousTime).TotalSeconds

  if (-not $botPid -or -not (Get-Process -Id $botPid -ErrorAction SilentlyContinue)) {
    $botPid = Get-UltronBotPid
  }

  $botProcess = if ($botPid) { Get-Process -Id $botPid -ErrorAction SilentlyContinue } else { $null }
  $botCpuSeconds = if ($botProcess) { [double]$botProcess.CPU } else { 0 }
  $discordCpuSeconds = [double](Get-DiscordCpuSeconds)

  $counter = Get-Counter `
    "\Processor(_Total)\% Processor Time", `
    "\PhysicalDisk(_Total)\Avg. Disk sec/Transfer", `
    "\Memory\Available MBytes" `
    -SampleInterval 1 `
    -MaxSamples 1

  $counterValues = @{}
  foreach ($sample in $counter.CounterSamples) {
    $counterValues[$sample.Path] = $sample.CookedValue
  }

  $runtime = $null
  try {
    $runtime = Invoke-RestMethod -Uri "http://127.0.0.1:10000/metrics" -TimeoutSec 3
  } catch {}

  $player = $null
  if ($runtime -and $runtime.metrics -and $runtime.metrics.players) {
    $player = @($runtime.metrics.players | Where-Object { $_.currentTrack } | Select-Object -First 1)[0]
    if (-not $player) {
      $player = @($runtime.metrics.players | Select-Object -First 1)[0]
    }
  }

  $eventLoop = $null
  if ($runtime -and $runtime.metrics -and $runtime.metrics.eventLoopDelayMs) {
    $eventLoop = $runtime.metrics.eventLoopDelayMs
  }

  $voicePing = $null
  if ($player -and $player.voicePingMs) {
    $voicePing = $player.voicePingMs
  }

  $currentTrack = $null
  if ($player -and $player.currentTrack) {
    $currentTrack = $player.currentTrack
  }

  $currentVoicePackets = if ($player -and $null -ne $player.voicePacketsPlayed) {
    [double]$player.voicePacketsPlayed
  } else {
    $null
  }

  $row = [PSCustomObject]@{
    sampledAt = $now.ToString("o")
    totalCpuPercent = [Math]::Round($counterValues["\\$env:COMPUTERNAME\processor(_total)\% processor time"], 2)
    diskTransferMs = [Math]::Round($counterValues["\\$env:COMPUTERNAME\physicaldisk(_total)\avg. disk sec/transfer"] * 1000, 3)
    availableMemoryMb = [Math]::Round($counterValues["\\$env:COMPUTERNAME\memory\available mbytes"], 0)
    botPid = $botPid
    botCpuPercent = Get-ProcessCpuPercent $botCpuSeconds $previousBotCpu $elapsedSeconds
    botMemoryMb = if ($botProcess) { [Math]::Round($botProcess.WorkingSet64 / 1MB, 1) } else { $null }
    discordCpuPercent = Get-ProcessCpuPercent $discordCpuSeconds $previousDiscordCpu $elapsedSeconds
    botLoopP95Ms = if ($eventLoop) { $eventLoop.p95 } else { $null }
    botLoopMaxMs = if ($eventLoop) { $eventLoop.max } else { $null }
    guild = if ($player) { $player.guildName } else { $null }
    connectionStatus = if ($player) { $player.connectionStatus } else { $null }
    playerStatus = if ($player) { $player.playerStatus } else { $null }
    sourceType = if ($player) { $player.sourceType } else { $null }
    voiceWsMs = if ($voicePing) { $voicePing.ws } else { $null }
    voiceUdpMs = if ($voicePing) { $voicePing.udp } else { $null }
    voicePacketsPlayed = $currentVoicePackets
    voicePacketsPerSecond = Get-DeltaRate $currentVoicePackets $previousVoicePackets $elapsedSeconds
    voiceSequence = if ($player) { $player.voiceSequence } else { $null }
    voiceSpeaking = if ($player) { $player.voiceSpeaking } else { $null }
    subscriberCount = if ($player) { $player.subscriberCount } else { $null }
    audioPlaybackDurationMs = if ($player) { $player.audioPlaybackDurationMs } else { $null }
    audioMissedFrames = if ($player) { $player.audioMissedFrames } else { $null }
    queueLength = if ($player) { $player.queueLength } else { $null }
    currentTitle = if ($currentTrack) { $currentTrack.title } else { $null }
    lastError = if ($player) { $player.lastError } else { $null }
  }

  $row | Export-Csv -Path $outputPath -NoTypeInformation -Append

  Write-Host (
    "{0} cpu={1}% bot={2}% discord={3}% loopP95={4}ms packets={5}/s missed={6} udp={7}ms source={8} title={9}" -f
    $row.sampledAt,
    $row.totalCpuPercent,
    $row.botCpuPercent,
    $row.discordCpuPercent,
    $row.botLoopP95Ms,
    $row.voicePacketsPerSecond,
    $row.audioMissedFrames,
    $row.voiceUdpMs,
    $row.sourceType,
    $row.currentTitle
  )

  $previousTime = $now
  $previousBotCpu = $botCpuSeconds
  $previousDiscordCpu = $discordCpuSeconds
  $previousVoicePackets = $currentVoicePackets

  Start-Sleep -Seconds $IntervalSeconds
}

Write-Host "Diagnostico terminado: $outputPath"
