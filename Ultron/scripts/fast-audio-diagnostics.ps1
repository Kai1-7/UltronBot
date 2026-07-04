param(
  [int]$Seconds = 60,
  [int]$IntervalMilliseconds = 50,
  [switch]$PrintEverySample
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $projectRoot "logs"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputPath = Join-Path $logDir "fast-audio-diagnostics-$stamp.csv"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host "Guardando diagnostico rapido en: $outputPath"
Write-Host "Intervalo externo: ${IntervalMilliseconds}ms. Monitor interno del bot: 50ms."

$endAt = (Get-Date).AddSeconds($Seconds)
$previousPackets = $null
$previousSampleAt = $null
$lastPrintedSecond = -1
$lastAnomalyCount = 0

while ((Get-Date) -lt $endAt) {
  $sampleStartedAt = Get-Date
  $runtime = $null
  $errorMessage = $null

  try {
    $runtime = Invoke-RestMethod -Uri "http://127.0.0.1:10000/metrics" -TimeoutSec 2
  } catch {
    $errorMessage = $_.Exception.Message
  }

  $metrics = if ($runtime) { $runtime.metrics } else { $null }
  $player = $null

  if ($metrics -and $metrics.players) {
    $player = @($metrics.players | Where-Object { $_.currentTrack } | Select-Object -First 1)[0]
    if (-not $player) {
      $player = @($metrics.players | Select-Object -First 1)[0]
    }
  }

  $realtime = if ($metrics) { $metrics.realtime } else { $null }
  $playerRealtime = $null

  if ($realtime -and $realtime.playerStates -and $player) {
    $playerRealtime = @($realtime.playerStates | Where-Object { $_.guildId -eq $player.guildId } | Select-Object -First 1)[0]
  }

  $recentAnomalies = if ($realtime -and $realtime.recentAnomalies) { @($realtime.recentAnomalies) } else { @() }
  $lastAnomaly = if ($recentAnomalies.Count -gt 0) { $recentAnomalies[$recentAnomalies.Count - 1] } else { $null }
  $packetsPlayed = if ($player -and $null -ne $player.voicePacketsPlayed) { [double]$player.voicePacketsPlayed } else { $null }
  $elapsedMs = if ($previousSampleAt) { ($sampleStartedAt - $previousSampleAt).TotalMilliseconds } else { $null }
  $packetDelta = if ($null -ne $packetsPlayed -and $null -ne $previousPackets) { $packetsPlayed - $previousPackets } else { $null }
  $packetsPerSecond = if ($null -ne $packetDelta -and $elapsedMs -gt 0) {
    [Math]::Round(($packetDelta / $elapsedMs) * 1000, 2)
  } else {
    $null
  }

  $newAnomalies = if ($realtime) { [int]$realtime.anomalyCount - $lastAnomalyCount } else { 0 }

  $row = [PSCustomObject]@{
    sampledAt = $sampleStartedAt.ToString("o")
    error = $errorMessage
    botCpuPercent = if ($metrics) { $metrics.cpuPercent } else { $null }
    botLoopP95Ms = if ($metrics) { $metrics.eventLoopDelayMs.p95 } else { $null }
    botLoopMaxMs = if ($metrics) { $metrics.eventLoopDelayMs.max } else { $null }
    realtimeSampleCount = if ($realtime) { $realtime.sampleCount } else { $null }
    realtimeMaxLoopDriftMs = if ($realtime) { $realtime.maxLoopDriftMs } else { $null }
    realtimeMaxPacketStallMs = if ($realtime) { $realtime.maxPacketStallMs } else { $null }
    realtimeAnomalyCount = if ($realtime) { $realtime.anomalyCount } else { $null }
    newAnomalies = $newAnomalies
    guild = if ($player) { $player.guildName } else { $null }
    connectionStatus = if ($player) { $player.connectionStatus } else { $null }
    playerStatus = if ($player) { $player.playerStatus } else { $null }
    sourceType = if ($player) { $player.sourceType } else { $null }
    packetsPlayed = $packetsPlayed
    packetsDelta = $packetDelta
    packetsPerSecond = $packetsPerSecond
    monitorPacketsPerSecond = if ($playerRealtime) { $playerRealtime.packetsPerSecond } else { $null }
    currentPacketStallMs = if ($playerRealtime) { $playerRealtime.currentPacketStallMs } else { $null }
    maxPlayerPacketStallMs = if ($playerRealtime) { $playerRealtime.maxPacketStallMs } else { $null }
    audioMissedFrames = if ($player) { $player.audioMissedFrames } else { $null }
    voiceWsMs = if ($player) { $player.voicePingMs.ws } else { $null }
    voiceUdpMs = if ($player) { $player.voicePingMs.udp } else { $null }
    currentTitle = if ($player -and $player.currentTrack) { $player.currentTrack.title } else { $null }
    lastAnomalyAt = if ($lastAnomaly) { $lastAnomaly.at } else { $null }
    lastAnomalyType = if ($lastAnomaly) { $lastAnomaly.type } else { $null }
    lastAnomalyDriftMs = if ($lastAnomaly) { $lastAnomaly.driftMs } else { $null }
    lastAnomalyPacketStallMs = if ($lastAnomaly) { $lastAnomaly.packetStallMs } else { $null }
  }

  $row | Export-Csv -Path $outputPath -NoTypeInformation -Append

  $shouldPrint =
    $PrintEverySample -or
    $newAnomalies -gt 0 -or
    $sampleStartedAt.Second -ne $lastPrintedSecond

  if ($shouldPrint) {
    Write-Host (
      "{0} pps={1} stall={2}ms missed={3} loopMax={4}ms anomalies={5}+{6} last={7}" -f
      $sampleStartedAt.ToString("HH:mm:ss.fff"),
      $row.packetsPerSecond,
      $row.currentPacketStallMs,
      $row.audioMissedFrames,
      $row.botLoopMaxMs,
      $row.realtimeAnomalyCount,
      $row.newAnomalies,
      $row.lastAnomalyType
    )

    $lastPrintedSecond = $sampleStartedAt.Second
  }

  if ($realtime) {
    $lastAnomalyCount = [int]$realtime.anomalyCount
  }

  $previousPackets = $packetsPlayed
  $previousSampleAt = $sampleStartedAt

  $elapsedThisLoopMs = ((Get-Date) - $sampleStartedAt).TotalMilliseconds
  $sleepMs = [Math]::Max(1, $IntervalMilliseconds - [int]$elapsedThisLoopMs)
  Start-Sleep -Milliseconds $sleepMs
}

Write-Host "Diagnostico rapido terminado: $outputPath"
