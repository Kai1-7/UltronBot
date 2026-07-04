const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const youtubedl = require("youtube-dl-exec");

const ffmpegStatic = require("ffmpeg-static");
const { config } = require("../config");

const STREAM_FLAGS = {
  getUrl: true,
  format: "bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[acodec!=none]/bestaudio/best",
  noWarnings: true,
  noCheckCertificates: true,
  preferFreeFormats: true,
  noPlaylist: true
};

const CACHE_INDEX_FILE = "index.json";
const CACHE_VERSION = "opus128-v1";
const CACHE_AUDIO_BITRATE = "128k";
const activeDownloads = new Map();

async function cacheTrackAudio(track) {
  if (!track?.url) {
    throw new Error("La pista no tiene URL para cachear.");
  }

  await fs.mkdir(config.audioCacheDir, { recursive: true });

  const key = createTrackKey(track.url);
  const outputPath = getCachedAudioPath(key);

  if (await isUsableFile(outputPath)) {
    await updateCacheIndex(key, track, outputPath);
    return outputPath;
  }

  if (!activeDownloads.has(key)) {
    activeDownloads.set(key, prepareCachedOpus(track, key, outputPath));
  }

  try {
    return await activeDownloads.get(key);
  } finally {
    activeDownloads.delete(key);
  }
}

async function getCachedTrackAudio(track) {
  if (!track?.url) {
    return null;
  }

  const key = createTrackKey(track.url);
  const outputPath = getCachedAudioPath(key);

  if (!(await isUsableFile(outputPath))) {
    return null;
  }

  await updateCacheIndex(key, track, outputPath);
  return outputPath;
}

async function prepareCachedOpus(track, key, outputPath) {
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    const streamUrl = await getStreamUrl(track.url);
    await transcodeToOpusFile(streamUrl, tempPath);
    await fs.rename(tempPath, outputPath);
    await updateCacheIndex(key, track, outputPath);
    await cleanupAudioCache(outputPath);
    return outputPath;
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function getStreamUrl(sourceUrl) {
  const output = await youtubedl(sourceUrl, STREAM_FLAGS);
  const streamUrl = String(output)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  if (!streamUrl) {
    throw new Error("yt-dlp no devolvio una URL reproducible.");
  }

  return streamUrl;
}

function transcodeToOpusFile(streamUrl, outputPath) {
  const ffmpegPath = ffmpegStatic.path || ffmpegStatic;
  const args = [
    "-hide_banner",
    "-y",
    "-nostdin",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_at_eof",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_on_http_error",
    "4xx,5xx",
    "-reconnect_delay_max",
    "10",
    "-i",
    streamUrl,
    "-analyzeduration",
    "0",
    "-loglevel",
    "error",
    "-vn",
    "-filter:a",
    "volume=0.85",
    "-acodec",
    "libopus",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-application",
    "audio",
    "-compression_level",
    "5",
    "-frame_duration",
    "20",
    "-b:a",
    CACHE_AUDIO_BITRATE,
    "-f",
    "opus",
    outputPath
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });

    const stderr = [];
    setBackgroundPriority(child.pid);

    child.stderr.on("data", chunk => {
      stderr.push(chunk);
    });

    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`FFmpeg termino con codigo ${code}: ${Buffer.concat(stderr).toString().trim()}`));
    });
  });
}

async function updateCacheIndex(key, track, filePath) {
  const index = await readCacheIndex();
  const stats = await fs.stat(filePath);
  const existing = index[key];

  index[key] = {
    title: track.title || existing?.title || "Audio sin titulo",
    url: track.url,
    duration: track.duration || existing?.duration || "En vivo",
    thumbnail: track.thumbnail || existing?.thumbnail || null,
    file: path.basename(filePath),
    size: stats.size,
    cacheVersion: CACHE_VERSION,
    audioBitrate: CACHE_AUDIO_BITRATE,
    uses: (existing?.uses || 0) + 1,
    lastUsedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString()
  };

  await writeCacheIndex(index);
  await touchFile(filePath);
}

async function cleanupAudioCache(keepPath) {
  const maxBytes = config.audioCacheMaxMb * 1024 * 1024;

  if (maxBytes <= 0) {
    return;
  }

  const entries = await fs.readdir(config.audioCacheDir, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || entry.name === CACHE_INDEX_FILE || !entry.name.endsWith(".opus")) {
      continue;
    }

    const filePath = path.join(config.audioCacheDir, entry.name);
    const stats = await fs.stat(filePath).catch(() => null);

    if (stats) {
      files.push({ filePath, size: stats.size, mtimeMs: stats.mtimeMs });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const index = await readCacheIndex();

  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= maxBytes) {
      break;
    }

    if (file.filePath === keepPath) {
      continue;
    }

    await fs.unlink(file.filePath).catch(() => {});
    delete index[path.basename(file.filePath, ".opus")];
    totalBytes -= file.size;
  }

  await writeCacheIndex(index);
}

async function readCacheIndex() {
  const indexPath = path.join(config.audioCacheDir, CACHE_INDEX_FILE);

  try {
    return JSON.parse(await fs.readFile(indexPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeCacheIndex(index) {
  const indexPath = path.join(config.audioCacheDir, CACHE_INDEX_FILE);
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

async function isUsableFile(filePath) {
  const stats = await fs.stat(filePath).catch(() => null);
  return Boolean(stats?.isFile() && stats.size > 0);
}

async function touchFile(filePath) {
  const now = new Date();
  await fs.utimes(filePath, now, now).catch(() => {});
}

function getCachedAudioPath(key) {
  return path.join(config.audioCacheDir, `${key}.opus`);
}

function createTrackKey(sourceUrl) {
  return crypto.createHash("sha1").update(`${CACHE_VERSION}:${sourceUrl}`).digest("hex").slice(0, 20);
}

function setBackgroundPriority(pid) {
  if (!pid) {
    return;
  }

  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}
}

module.exports = { cacheTrackAudio, getCachedTrackAudio };
