const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const LRCLIB_SEARCH_URL = "https://lrclib.net/api/search";
const LRCLIB_GET_URL = "https://lrclib.net/api/get";
const GOOGLE_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/single";
const LYRICS_CACHE_MAX = 100;
const LYRICS_CACHE_TTL_MS = 30 * 60 * 1000;
const LYRICS_DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LYRICS_REQUEST_TIMEOUT_MS = 15000;
const TRANSLATION_REQUEST_TIMEOUT_MS = 8000;
const TRANSLATION_CHUNK_MAX = 1100;
const SYNC_TRANSLATION_CHUNK_MAX = 900;
const LYRICS_CACHE_DIR = process.env.LYRICS_CACHE_DIR?.trim() || path.join(__dirname, "..", "..", "cache", "lyrics");

const lyricsCache = new Map();

async function findSpanishLyrics(track) {
  const cacheKey = `display-es:${getTrackCacheKey(track)}`;
  const cached = await getCachedLyrics(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const originalLyrics = await findOriginalLyrics(track);

  if (!originalLyrics) {
    await setCachedLyrics(cacheKey, null);
    return null;
  }

  if (isLikelySpanish(originalLyrics.lyrics)) {
    const value = {
      ...originalLyrics,
      translated: false
    };

    await setCachedLyrics(cacheKey, value);
    return value;
  }

  const translatedLyrics = await translateLyricsToSpanish(originalLyrics.lyrics);

  if (!translatedLyrics || !isLikelySpanish(translatedLyrics)) {
    return null;
  }

  const value = {
    ...originalLyrics,
    lyrics: translatedLyrics,
    source: `${originalLyrics.source} + traduccion automatica`,
    translated: true
  };

  await setCachedLyrics(cacheKey, value);
  return value;
}

async function findSyncedSpanishLyrics(track) {
  const cacheKey = `sync-es:${getTrackCacheKey(track)}`;
  const cached = await getCachedLyrics(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const originalLyrics = await findOriginalSyncedLyrics(track);

  if (!originalLyrics?.syncedLines?.length) {
    await setCachedLyrics(cacheKey, null);
    return null;
  }

  if (isLikelySpanish(originalLyrics.lyrics)) {
    const value = {
      ...originalLyrics,
      lines: originalLyrics.syncedLines,
      translated: false
    };

    await setCachedLyrics(cacheKey, value);
    return value;
  }

  const translatedLines = await translateSyncedLinesToSpanish(originalLyrics.syncedLines);

  if (!translatedLines?.length || !isLikelySpanish(translatedLines.map(line => line.text).join("\n"))) {
    return null;
  }

  const value = {
    ...originalLyrics,
    lines: translatedLines,
    lyrics: translatedLines.map(line => line.text).join("\n"),
    source: `${originalLyrics.source} + traduccion automatica`,
    translated: true
  };

  await setCachedLyrics(cacheKey, value);
  return value;
}

async function findOriginalLyrics(track) {
  return findLyrics(track, { spanishOnly: false });
}

async function findOriginalSyncedLyrics(track) {
  return findLyrics(track, { requireSynced: true, spanishOnly: false });
}

async function findLyrics(track, options = {}) {
  const cacheKey = getTrackCacheKey(track);
  const normalizedCacheKey = `${options.spanishOnly ? "es" : "any"}:${options.requireSynced ? "synced" : "plain"}:${cacheKey}`;
  const cached = await getCachedLyrics(normalizedCacheKey);

  if (cached !== undefined) {
    return cached;
  }

  const parsed = parseTrackTitle(track?.title || "");
  const exactMatch = await fetchExactLyrics(parsed, track);

  if (exactMatch) {
    const exactLyrics = createLyricsValue(exactMatch);

    if (
      exactLyrics &&
      (!options.requireSynced || exactLyrics.syncedLines.length > 0) &&
      (!options.spanishOnly || isLikelySpanish(exactLyrics.lyrics))
    ) {
      await setCachedLyrics(normalizedCacheKey, exactLyrics);
      return exactLyrics;
    }
  }

  const queries = createLyricsQueries(track);

  for (const query of queries) {
    const results = await searchLyrics(query);

    if (!results) {
      break;
    }

    const match = chooseBestMatch(results, track, options);

    if (!match) {
      continue;
    }

    const value = createLyricsValue(match);

    if (!value || (options.spanishOnly && !isLikelySpanish(value.lyrics))) {
      continue;
    }

    await setCachedLyrics(normalizedCacheKey, value);
    return value;
  }

  await setCachedLyrics(normalizedCacheKey, null);
  return null;
}

async function fetchExactLyrics(parsed, track) {
  if (!parsed.artistName || !parsed.trackName) {
    return null;
  }

  const durationSeconds = parseDurationSeconds(track?.duration);
  const params = new URLSearchParams({
    artist_name: parsed.artistName,
    track_name: parsed.trackName
  });

  if (Number.isFinite(durationSeconds)) {
    params.set("duration", String(durationSeconds));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LYRICS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${LRCLIB_GET_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "UltronBot/2.0"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const result = await response.json();
    const score = scoreLyricsMatch(result, parsed, durationSeconds);

    return score >= 12 ? result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchLyrics(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LYRICS_REQUEST_TIMEOUT_MS);

  try {
    const url = `${LRCLIB_SEARCH_URL}?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "UltronBot/2.0"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function createLyricsValue(match) {
  const syncedLines = parseSyncedLyrics(match?.syncedLyrics);
  const lyrics = normalizeLyrics(match?.plainLyrics || stripSyncedTimestamps(match?.syncedLyrics));

  if (!lyrics) {
    return null;
  }

  return {
    lyrics,
    source: "LRCLIB",
    trackName: match.trackName || match.name || null,
    artistName: match.artistName || null,
    synced: syncedLines.length > 0,
    syncedLines
  };
}

function parseSyncedLyrics(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);

      if (!match) {
        return null;
      }

      const minutes = Number.parseInt(match[1], 10);
      const seconds = Number.parseInt(match[2], 10);
      const fraction = match[3] ? Number.parseInt(match[3].padEnd(3, "0").slice(0, 3), 10) : 0;
      const lyric = match[4].trim();

      if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !lyric) {
        return null;
      }

      return {
        timeMs: (minutes * 60 + seconds) * 1000 + fraction,
        text: lyric
      };
    })
    .filter(Boolean);
}

async function translateLyricsToSpanish(text) {
  const chunks = splitTextForTranslation(text);
  const translatedChunks = [];

  for (const chunk of chunks) {
    const translatedChunk = await translateTextToSpanish(chunk);

    if (!translatedChunk) {
      return null;
    }

    translatedChunks.push(translatedChunk);
  }

  return normalizeLyrics(translatedChunks.join("\n\n"));
}

async function translateSyncedLinesToSpanish(lines) {
  const chunks = splitSyncedLinesForTranslation(lines);
  const translatedLines = new Map();

  for (const chunk of chunks) {
    const translatedChunk = await translateMarkedLinesToSpanish(chunk);

    if (!translatedChunk) {
      return null;
    }

    for (const line of translatedChunk) {
      translatedLines.set(line.index, line.text);
    }
  }

  return lines.map((line, index) => ({
    timeMs: line.timeMs,
    text: translatedLines.get(index) || line.text
  }));
}

async function translateMarkedLinesToSpanish(lines) {
  const payload = lines
    .map(line => `[[${line.index}]] ${line.text}`)
    .join("\n");
  const translated = await translateTextToSpanish(payload);

  if (!translated) {
    return null;
  }

  const parsed = parseTranslatedMarkedLines(translated);

  if (parsed.length !== lines.length) {
    return translateLinesIndividually(lines);
  }

  return parsed;
}

async function translateLinesIndividually(lines) {
  const translatedLines = [];

  for (const line of lines) {
    const translated = await translateTextToSpanish(line.text);

    if (!translated) {
      return null;
    }

    translatedLines.push({
      index: line.index,
      text: translated
    });
  }

  return translatedLines;
}

function parseTranslatedMarkedLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => {
      const match = line.match(/^\s*\[\[(\d+)]]\s*(.+?)\s*$/);

      if (!match) {
        return null;
      }

      return {
        index: Number.parseInt(match[1], 10),
        text: match[2].trim()
      };
    })
    .filter(line => line && Number.isFinite(line.index) && line.text);
}

function splitSyncedLinesForTranslation(lines) {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  lines.forEach((line, index) => {
    const item = {
      index,
      text: line.text
    };
    const itemLength = item.text.length + 10;

    if (current.length > 0 && currentLength + itemLength > SYNC_TRANSLATION_CHUNK_MAX) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }

    current.push(item);
    currentLength += itemLength;
  });

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function translateTextToSpanish(text) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATION_REQUEST_TIMEOUT_MS);

  try {
    const params = new URLSearchParams({
      client: "gtx",
      sl: "auto",
      tl: "es",
      dt: "t",
      q: text
    });
    const response = await fetch(`${GOOGLE_TRANSLATE_URL}?${params.toString()}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "UltronBot/2.0"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (!Array.isArray(data?.[0])) {
      return null;
    }

    return data[0]
      .map(part => part?.[0] || "")
      .join("")
      .trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function splitTextForTranslation(text) {
  const lines = normalizeLyrics(text).split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if (line.length > TRANSLATION_CHUNK_MAX) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = "";
      }

      chunks.push(...splitLongLine(line, TRANSLATION_CHUNK_MAX));
      continue;
    }

    const next = current ? `${current}\n${line}` : line;

    if (next.length > TRANSLATION_CHUNK_MAX && current.trim()) {
      chunks.push(current.trim());
      current = line;
    } else {
      current = next;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

function splitLongLine(line, maxLength) {
  const chunks = [];
  let remaining = line;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf(" ", maxLength);

    if (splitAt < maxLength * 0.5) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function createLyricsQueries(track) {
  const parsed = parseTrackTitle(track?.title || "");
  const values = [
    parsed.artistName && parsed.trackName ? `${parsed.artistName} ${parsed.trackName}` : null,
    parsed.trackName,
    parsed.cleanedTitle,
    track?.title
  ];

  return [...new Set(values.map(value => normalizeQuery(value)).filter(Boolean))];
}

function parseTrackTitle(title) {
  const cleanedTitle = cleanVideoTitle(title);
  const split = cleanedTitle.split(/\s+-\s+|\s+–\s+|\s+—\s+/);

  if (split.length >= 2) {
    return {
      artistName: split[0].trim(),
      trackName: split.slice(1).join(" - ").trim(),
      cleanedTitle
    };
  }

  return {
    artistName: null,
    trackName: cleanedTitle,
    cleanedTitle
  };
}

function cleanVideoTitle(title) {
  return String(title || "")
    .replace(/\|.*$/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:official|video oficial|audio|lyrics?|letra|visualizer|mv|hd|4k|remaster(?:ed)?|live)[^)]*\)/gi, " ")
    .replace(/\b(?:official|video oficial|audio|lyrics?|letra|visualizer|mv|hd|4k|remaster(?:ed)?|live)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseBestMatch(results, track, options = {}) {
  const durationSeconds = parseDurationSeconds(track?.duration);
  const parsed = parseTrackTitle(track?.title || "");
  let bestMatch = null;
  let bestScore = 0;

  for (const result of results) {
    const lyrics = normalizeLyrics(result?.plainLyrics || stripSyncedTimestamps(result?.syncedLyrics));

    if (
      !lyrics ||
      result?.instrumental ||
      (options.requireSynced && !result?.syncedLyrics) ||
      (options.spanishOnly && !isLikelySpanish(lyrics))
    ) {
      continue;
    }

    const score = scoreLyricsMatch(result, parsed, durationSeconds);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = result;
    }
  }

  return bestScore >= 4 ? bestMatch : null;
}

function scoreLyricsMatch(result, parsed, durationSeconds) {
  const resultTrack = normalizeComparable(result?.trackName || result?.name);
  const resultName = normalizeComparable(result?.name);
  const resultArtist = normalizeComparable(result?.artistName);
  const wantedTrack = normalizeComparable(parsed.trackName);
  const wantedArtist = normalizeComparable(parsed.artistName);
  let score = 0;
  let trackScore = 0;

  if (wantedTrack && (resultTrack || resultName)) {
    if (resultTrack === wantedTrack || resultName === wantedTrack) {
      trackScore = 12;
    } else if (hasStrongTitleOverlap(wantedTrack, resultTrack) || hasStrongTitleOverlap(wantedTrack, resultName)) {
      trackScore = 7;
    }
  }

  if (wantedTrack && trackScore === 0) {
    return 0;
  }

  score += trackScore;

  if (wantedArtist && resultArtist) {
    if (resultArtist === wantedArtist) {
      score += 8;
    } else if (resultArtist.includes(wantedArtist) || wantedArtist.includes(resultArtist)) {
      score += 4;
    }
  }

  if (Number.isFinite(durationSeconds) && Number.isFinite(result?.duration)) {
    const delta = Math.abs(Number(result.duration) - durationSeconds);

    if (delta <= 3) {
      score += 5;
    } else if (delta <= 12) {
      score += 2;
    }
  }

  if (result?.plainLyrics) {
    score += 2;
  }

  if (result?.syncedLyrics) {
    score += 1;
  }

  return score;
}

function isLikelySpanish(text) {
  const tokens = normalizeComparable(text).match(/[a-z0-9]+/g) || [];

  if (tokens.length < 20) {
    return false;
  }

  const strongSpanishWords = new Set([
    "ahora",
    "amor",
    "aunque",
    "aqui",
    "asi",
    "cancion",
    "corazon",
    "cuando",
    "donde",
    "eres",
    "estoy",
    "hasta",
    "mientras",
    "noche",
    "nunca",
    "puedo",
    "quiero",
    "sabes",
    "siempre",
    "tengo",
    "vida",
    "vuelve"
  ]);
  const spanishWords = new Set([
    "al",
    "algo",
    "aqui",
    "asi",
    "como",
    "con",
    "cuando",
    "de",
    "del",
    "dime",
    "donde",
    "el",
    "ella",
    "en",
    "eres",
    "es",
    "esta",
    "estoy",
    "la",
    "las",
    "lo",
    "los",
    "mas",
    "me",
    "mi",
    "mira",
    "no",
    "para",
    "pero",
    "por",
    "porque",
    "que",
    "quiero",
    "se",
    "si",
    "sin",
    "soy",
    "te",
    "tu",
    "una",
    "ve",
    "vez",
    "yo"
  ]);
  const englishWords = new Set([
    "and",
    "are",
    "for",
    "from",
    "have",
    "in",
    "is",
    "it",
    "love",
    "my",
    "of",
    "on",
    "that",
    "the",
    "to",
    "was",
    "we",
    "with",
    "you",
    "your"
  ]);
  const frenchWords = new Set([
    "au",
    "aux",
    "avec",
    "ce",
    "ces",
    "dans",
    "des",
    "du",
    "elle",
    "en",
    "est",
    "et",
    "je",
    "la",
    "le",
    "les",
    "mon",
    "ne",
    "nous",
    "pas",
    "pour",
    "que",
    "qui",
    "se",
    "sur",
    "tu",
    "un",
    "une",
    "vous"
  ]);

  let spanishCount = 0;
  let strongSpanishCount = 0;
  let englishCount = 0;
  let frenchCount = 0;

  for (const token of tokens) {
    if (spanishWords.has(token)) {
      spanishCount++;
    }

    if (strongSpanishWords.has(token)) {
      strongSpanishCount++;
      spanishCount += 2;
    }

    if (englishWords.has(token)) {
      englishCount++;
    }

    if (frenchWords.has(token)) {
      frenchCount++;
    }
  }

  const hasSpanishOnlyCharacters = /[ñ¿¡]/i.test(text);
  const hasSpanishAccentSignals = /[áíóú]/i.test(text);
  const hasFrenchAccentSignals = /[àâæçèêëîïôœùûÿ]/i.test(text);
  const spanishRatio = spanishCount / tokens.length;
  const competitorCount = englishCount + frenchCount;

  if (hasFrenchAccentSignals && frenchCount >= spanishCount) {
    return false;
  }

  if (strongSpanishCount < 2 && !hasSpanishOnlyCharacters) {
    return false;
  }

  if (competitorCount > 0 && spanishCount < competitorCount + 5) {
    return false;
  }

  return spanishRatio >= 0.08 || (hasSpanishOnlyCharacters && spanishCount >= 5) || (hasSpanishAccentSignals && strongSpanishCount >= 3);
}

function hasStrongTitleOverlap(wantedTrack, resultTrack) {
  if (!wantedTrack || !resultTrack) {
    return false;
  }

  const wantedTokens = contentTitleTokens(wantedTrack);
  const resultTokens = contentTitleTokens(resultTrack);

  if (wantedTokens.length === 0 || resultTokens.length === 0) {
    return false;
  }

  const resultTokenSet = new Set(resultTokens);
  const overlap = wantedTokens.filter(token => resultTokenSet.has(token));
  const missingWantedTokens = wantedTokens.filter(token => !resultTokenSet.has(token));
  const extraResultTokens = resultTokens.filter(token => !wantedTokens.includes(token));
  const overlapRatio = overlap.length / Math.max(wantedTokens.length, resultTokens.length);
  const onlySafeDifferences =
    missingWantedTokens.every(isSafeTitleDescriptorToken) &&
    extraResultTokens.every(isSafeTitleDescriptorToken);

  return overlapRatio >= 0.8 && onlySafeDifferences && overlap.length >= Math.min(wantedTokens.length, resultTokens.length);
}

function isSafeTitleDescriptorToken(token) {
  const safeDescriptors = new Set([
    "acoustic",
    "audio",
    "edit",
    "extended",
    "hd",
    "karaoke",
    "live",
    "lyric",
    "lyrics",
    "official",
    "remaster",
    "remastered",
    "remix",
    "session",
    "sessions",
    "version",
    "video"
  ]);

  return safeDescriptors.has(token);
}

function contentTitleTokens(value) {
  const ignored = new Set([
    "a",
    "an",
    "and",
    "de",
    "el",
    "en",
    "feat",
    "ft",
    "la",
    "le",
    "los",
    "of",
    "the",
    "un",
    "una",
    "with",
    "y"
  ]);

  return normalizeComparable(value)
    .split(" ")
    .filter(token => token.length > 1 && !ignored.has(token));
}

function parseDurationSeconds(duration) {
  if (!duration || duration === "En vivo") {
    return null;
  }

  const parts = String(duration)
    .split(":")
    .map(part => Number.parseInt(part, 10));

  if (parts.some(part => !Number.isFinite(part))) {
    return null;
  }

  return parts.reduce((total, part) => total * 60 + part, 0);
}

function stripSyncedTimestamps(text) {
  return String(text || "")
    .replace(/^\[[^\]]+\]\s*/gm, "")
    .trim();
}

function normalizeLyrics(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function normalizeQuery(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparable(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTrackCacheKey(track) {
  const parsed = parseTrackTitle(track?.title || "");
  const durationSeconds = parseDurationSeconds(track?.duration);

  if (parsed.cleanedTitle) {
    return normalizeComparable([
      parsed.artistName,
      parsed.trackName,
      Number.isFinite(durationSeconds) ? durationSeconds : null
    ].filter(Boolean).join("|"));
  }

  return track?.url || "";
}

async function getCachedLyrics(key) {
  const cached = lyricsCache.get(key);

  if (cached) {
    if (Date.now() - cached.createdAt <= LYRICS_CACHE_TTL_MS) {
      return cached.value;
    }

    lyricsCache.delete(key);
  }

  return readCachedLyricsFromDisk(key);
}

async function setCachedLyrics(key, value) {
  lyricsCache.set(key, {
    value,
    createdAt: Date.now()
  });

  while (lyricsCache.size > LYRICS_CACHE_MAX) {
    lyricsCache.delete(lyricsCache.keys().next().value);
  }

  if (value) {
    await writeCachedLyricsToDisk(key, value);
  }
}

async function readCachedLyricsFromDisk(key) {
  const filePath = getLyricsCachePath(key);

  try {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8"));

    if (!payload || Date.now() - payload.createdAt > LYRICS_DISK_CACHE_TTL_MS) {
      await fs.rm(filePath, { force: true }).catch(() => {});
      return undefined;
    }

    lyricsCache.set(key, {
      value: payload.value,
      createdAt: Date.now()
    });

    return payload.value;
  } catch {
    return undefined;
  }
}

async function writeCachedLyricsToDisk(key, value) {
  const filePath = getLyricsCachePath(key);
  const payload = {
    key,
    value,
    createdAt: Date.now()
  };

  try {
    await fs.mkdir(LYRICS_CACHE_DIR, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(payload), "utf8");
  } catch {}
}

function getLyricsCachePath(key) {
  const digest = crypto.createHash("sha256").update(key).digest("hex");
  return path.join(LYRICS_CACHE_DIR, `${digest}.json`);
}

module.exports = {
  findOriginalLyrics,
  findSpanishLyrics,
  findSyncedSpanishLyrics
};
