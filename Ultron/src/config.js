require("dotenv").config({ quiet: true });
const path = require("path");

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  token: process.env.TOKEN?.trim(),
  port: parseNumber(process.env.PORT, 10000),
  guildId: process.env.GUILD_ID?.trim() || null,
  inactivityTimeoutMs: parseNumber(process.env.INACTIVITY_TIMEOUT_MS, 120000),
  voiceReconnectEvery: parseNumber(process.env.VOICE_RECONNECT_EVERY, 10),
  audioCacheDir: process.env.AUDIO_CACHE_DIR?.trim() || path.join(__dirname, "..", "cache", "audio"),
  audioCacheMaxMb: parseNumber(process.env.AUDIO_CACHE_MAX_MB, 1000),
  audioPrebufferBytes: parseNumber(process.env.AUDIO_PREBUFFER_BYTES, 256 * 1024),
  audioPrebufferTimeoutMs: parseNumber(process.env.AUDIO_PREBUFFER_TIMEOUT_MS, 5000)
};

if (!config.token) {
  throw new Error("Falta la variable TOKEN. Colocala en tu .env o en las variables del host.");
}

module.exports = { config };
