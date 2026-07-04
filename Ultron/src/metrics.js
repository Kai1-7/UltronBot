const { monitorEventLoopDelay, performance } = require("perf_hooks");

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

const REALTIME_MONITOR_INTERVAL_MS = 50;
const LOOP_DRIFT_WARN_MS = 25;
const VOICE_PACKET_STALL_WARN_MS = 80;
const MAX_REALTIME_ANOMALIES = 300;

let lastCpuUsage = process.cpuUsage();
let lastSampleTime = process.hrtime.bigint();
let latestRuntimeMetrics = null;
let playerStatsProvider = () => [];
let realtimeMonitorTimer = null;
let realtimeMonitorLastAt = 0;
let realtimeMonitorStartedAt = null;
let realtimeSampleCount = 0;
let realtimeMaxLoopDriftMs = 0;
let realtimeMaxPacketStallMs = 0;
let realtimeAnomalies = [];
const realtimePlayerStates = new Map();

function sampleRuntimeMetrics() {
  const now = process.hrtime.bigint();
  const elapsedMs = Number(now - lastSampleTime) / 1e6;
  const cpuUsage = process.cpuUsage(lastCpuUsage);
  const cpuMs = (cpuUsage.user + cpuUsage.system) / 1000;
  const memoryUsage = process.memoryUsage();

  latestRuntimeMetrics = {
    sampledAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    cpuPercent: elapsedMs > 0 ? Number(((cpuMs / elapsedMs) * 100).toFixed(2)) : 0,
    memoryMb: Number((memoryUsage.rss / 1024 / 1024).toFixed(1)),
    heapUsedMb: Number((memoryUsage.heapUsed / 1024 / 1024).toFixed(1)),
    eventLoopDelayMs: {
      mean: Number((eventLoopDelay.mean / 1e6).toFixed(2)),
      p95: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(2)),
      max: Number((eventLoopDelay.max / 1e6).toFixed(2))
    },
    players: getPlayerStats(),
    realtime: getRealtimeMonitorSnapshot()
  };

  eventLoopDelay.reset();
  lastCpuUsage = process.cpuUsage();
  lastSampleTime = now;

  return latestRuntimeMetrics;
}

function getRuntimeMetrics() {
  return latestRuntimeMetrics ?? sampleRuntimeMetrics();
}

function setPlayerStatsProvider(provider) {
  playerStatsProvider = typeof provider === "function" ? provider : () => [];
}

function getPlayerStats() {
  try {
    return playerStatsProvider();
  } catch (error) {
    return [{ error: error?.message || "No pude leer metricas de reproductores." }];
  }
}

function startRealtimeMonitor() {
  if (realtimeMonitorTimer) {
    return;
  }

  realtimeMonitorStartedAt = new Date().toISOString();
  realtimeMonitorLastAt = performance.now();

  realtimeMonitorTimer = setInterval(sampleRealtimeMonitor, REALTIME_MONITOR_INTERVAL_MS);
  realtimeMonitorTimer.unref();
}

function sampleRealtimeMonitor() {
  const now = performance.now();
  const elapsedMs = now - realtimeMonitorLastAt;
  const loopDriftMs = elapsedMs - REALTIME_MONITOR_INTERVAL_MS;

  realtimeSampleCount++;
  realtimeMonitorLastAt = now;

  if (loopDriftMs > realtimeMaxLoopDriftMs) {
    realtimeMaxLoopDriftMs = loopDriftMs;
  }

  if (loopDriftMs >= LOOP_DRIFT_WARN_MS) {
    recordRealtimeAnomaly({
      type: "event_loop_drift",
      elapsedMs: roundNumber(elapsedMs),
      driftMs: roundNumber(loopDriftMs)
    });
  }

  const activeGuildIds = new Set();

  for (const player of getPlayerStats()) {
    if (!player?.guildId) {
      continue;
    }

    activeGuildIds.add(player.guildId);
    sampleRealtimePlayer(player, now);
  }

  for (const guildId of realtimePlayerStates.keys()) {
    if (!activeGuildIds.has(guildId)) {
      realtimePlayerStates.delete(guildId);
    }
  }
}

function sampleRealtimePlayer(player, now) {
  let state = realtimePlayerStates.get(player.guildId);

  if (!state) {
    state = {
      lastPacketsPlayed: null,
      lastPacketAt: now,
      lastMissedFrames: null,
      lastPacketStallReportAt: 0,
      maxPacketStallMs: 0,
      packetsPerSecond: null
    };
    realtimePlayerStates.set(player.guildId, state);
  }

  const isPlaying = player.currentTrack && player.playerStatus === "playing";
  const packetsPlayed = toFiniteNumber(player.voicePacketsPlayed);
  const missedFrames = toFiniteNumber(player.audioMissedFrames);

  if (!isPlaying || packetsPlayed === null) {
    state.lastPacketsPlayed = packetsPlayed;
    state.lastPacketAt = now;
    state.lastMissedFrames = missedFrames;
    state.packetsPerSecond = null;
    return;
  }

  if (state.lastPacketsPlayed === null || packetsPlayed > state.lastPacketsPlayed) {
    const previousPackets = state.lastPacketsPlayed;
    const previousPacketAt = state.lastPacketAt;

    state.lastPacketAt = now;

    if (previousPackets !== null && previousPacketAt) {
      const elapsedSincePacketMs = now - previousPacketAt;
      const packetDelta = packetsPlayed - previousPackets;
      state.packetsPerSecond = packetDelta > 0
        ? roundNumber((packetDelta / elapsedSincePacketMs) * 1000)
        : null;
    }
  }

  const packetStallMs = now - state.lastPacketAt;

  if (packetStallMs > state.maxPacketStallMs) {
    state.maxPacketStallMs = packetStallMs;
  }

  if (packetStallMs > realtimeMaxPacketStallMs) {
    realtimeMaxPacketStallMs = packetStallMs;
  }

  if (
    packetStallMs >= VOICE_PACKET_STALL_WARN_MS &&
    now - state.lastPacketStallReportAt >= VOICE_PACKET_STALL_WARN_MS
  ) {
    state.lastPacketStallReportAt = now;
    recordRealtimeAnomaly({
      type: "voice_packet_stall",
      guildName: player.guildName,
      title: player.currentTrack?.title ?? null,
      packetStallMs: roundNumber(packetStallMs),
      packetsPlayed,
      playerStatus: player.playerStatus,
      connectionStatus: player.connectionStatus,
      sourceType: player.sourceType
    });
  }

  if (missedFrames !== null && state.lastMissedFrames !== null && missedFrames > state.lastMissedFrames) {
    recordRealtimeAnomaly({
      type: "audio_missed_frames",
      guildName: player.guildName,
      title: player.currentTrack?.title ?? null,
      missedDelta: missedFrames - state.lastMissedFrames,
      missedFrames,
      sourceType: player.sourceType
    });
  }

  state.lastPacketsPlayed = packetsPlayed;
  state.lastMissedFrames = missedFrames;
}

function recordRealtimeAnomaly(anomaly) {
  realtimeAnomalies.push({
    at: new Date().toISOString(),
    ...anomaly
  });

  if (realtimeAnomalies.length > MAX_REALTIME_ANOMALIES) {
    realtimeAnomalies = realtimeAnomalies.slice(-MAX_REALTIME_ANOMALIES);
  }
}

function getRealtimeMonitorSnapshot() {
  const playerStates = [];

  for (const [guildId, state] of realtimePlayerStates) {
    playerStates.push({
      guildId,
      packetsPerSecond: state.packetsPerSecond,
      currentPacketStallMs: roundNumber(performance.now() - state.lastPacketAt),
      maxPacketStallMs: roundNumber(state.maxPacketStallMs)
    });
  }

  return {
    enabled: Boolean(realtimeMonitorTimer),
    startedAt: realtimeMonitorStartedAt,
    intervalMs: REALTIME_MONITOR_INTERVAL_MS,
    sampleCount: realtimeSampleCount,
    maxLoopDriftMs: roundNumber(realtimeMaxLoopDriftMs),
    maxPacketStallMs: roundNumber(realtimeMaxPacketStallMs),
    anomalyCount: realtimeAnomalies.length,
    recentAnomalies: realtimeAnomalies.slice(-20),
    playerStates
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function startMetricsLogger() {
  setInterval(() => {
    const metrics = sampleRuntimeMetrics();
    const activePlayers = metrics.players
      .filter(player => player.currentTrack)
      .map(player => {
        const ping = player.voicePingMs;
        return `${player.guildName}:${player.connectionStatus}/${player.playerStatus}` +
          ` ${player.sourceType || "idle"} ws=${ping?.ws ?? "?"} udp=${ping?.udp ?? "?"}`;
      })
      .join(" | ");

    console.log(
      `[Metrics] cpu=${metrics.cpuPercent}% rss=${metrics.memoryMb}MB ` +
        `loopP95=${metrics.eventLoopDelayMs.p95}ms loopMax=${metrics.eventLoopDelayMs.max}ms` +
        (activePlayers ? ` voice=${activePlayers}` : "")
    );
  }, 30_000).unref();
}

module.exports = {
  getRuntimeMetrics,
  sampleRuntimeMetrics,
  setPlayerStatsProvider,
  startRealtimeMonitor,
  startMetricsLogger
};
