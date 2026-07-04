const youtubedl = require("youtube-dl-exec");

const { formatDuration, trimForChoice } = require("../utils/format");

const METADATA_FLAGS = {
  dumpSingleJson: true,
  noWarnings: true,
  noCheckCertificates: true,
  preferFreeFormats: true,
  skipDownload: true,
  noPlaylist: true
};

const STREAM_FLAGS = {
  getUrl: true,
  format: "bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio[acodec!=none]/bestaudio/best",
  noWarnings: true,
  noCheckCertificates: true,
  preferFreeFormats: true,
  noPlaylist: true
};

const SEARCH_FLAGS = {
  dumpSingleJson: true,
  flatPlaylist: true,
  ignoreErrors: true,
  noWarnings: true,
  noCheckCertificates: true,
  skipDownload: true
};

const AUTOCOMPLETE_CACHE_MAX = 100;
const AUTOCOMPLETE_CACHE_TTL_MS = 10 * 60 * 1000;
const AUTOCOMPLETE_TIMEOUT_MS = 2300;

const autocompleteCache = new Map();
const activeAutocompletes = new Map();
const trackMetadataCache = new Map();

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function createResolverError(userMessage, cause) {
  const error = new Error(userMessage);
  error.cause = cause;
  return error;
}

async function resolveTrack(query, requestedBy) {
  const normalized = query.trim();

  if (!normalized) {
    throw new Error("Debes escribir el nombre de una cancion o una URL valida.");
  }

  if (isUrl(normalized)) {
    return resolveTrackFromUrl(normalized, requestedBy);
  }

  return resolveTrackFromSearch(normalized, requestedBy);
}

async function resolveTrackFromSearch(query, requestedBy) {
  try {
    const result = await youtubedl(`ytsearch1:${query}`, SEARCH_FLAGS);
    const firstVideo = result.entries?.find(video => video?.url || video?.webpage_url || video?.id);

    if (!firstVideo) {
      throw new Error("Sin resultados");
    }

    const track = videoToTrack(firstVideo);

    if (!track) {
      throw new Error("Resultado sin URL");
    }

    cacheTrackMetadata(track);
    return {
      ...track,
      requestedBy
    };
  } catch (error) {
    throw createResolverError("No encontre resultados para esa busqueda.", error);
  }
}

async function resolveTrackFromUrl(url, requestedBy) {
  const cachedTrack = getCachedTrackMetadata(url);

  if (cachedTrack) {
    return {
      ...cachedTrack,
      requestedBy
    };
  }

  try {
    const details = await youtubedl(url, METADATA_FLAGS);
    const track = {
      title: details.title || "Audio sin titulo",
      url: details.webpage_url || details.original_url || url,
      duration: formatDuration(details.duration_string || details.duration),
      thumbnail: details.thumbnail || null
    };

    cacheTrackMetadata(track, url);
    return {
      ...track,
      requestedBy
    };
  } catch (error) {
    throw createResolverError("No pude leer esa URL. Revisa que sea un enlace valido de YouTube.", error);
  }
}

async function getStreamUrl(sourceUrl) {
  try {
    const output = await youtubedl(sourceUrl, STREAM_FLAGS);
    const streamUrl = String(output)
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean);

    if (!streamUrl) {
      throw new Error("yt-dlp no devolvio una URL reproducible.");
    }

    return streamUrl;
  } catch (error) {
    throw createResolverError("No pude abrir el audio de esa cancion en este momento.", error);
  }
}

async function searchSuggestions(query) {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return [];
  }

  const cachedSuggestions = getCachedSuggestions(normalized);

  if (cachedSuggestions) {
    return cachedSuggestions;
  }

  const activeAutocomplete = activeAutocompletes.get(normalized);

  if (activeAutocomplete) {
    return withTimeout(activeAutocomplete, AUTOCOMPLETE_TIMEOUT_MS, findCachedSuggestions(normalized) ?? []);
  }

  const autocomplete = fetchSuggestions(normalized);
  activeAutocompletes.set(normalized, autocomplete);

  autocomplete.finally(() => {
    if (activeAutocompletes.get(normalized) === autocomplete) {
      activeAutocompletes.delete(normalized);
    }
  });

  return withTimeout(autocomplete, AUTOCOMPLETE_TIMEOUT_MS, findCachedSuggestions(normalized) ?? []);
}

async function fetchSuggestions(normalizedQuery) {
  try {
    const result = await youtubedl(`ytsearch5:${normalizedQuery}`, SEARCH_FLAGS);
    const suggestions = (result.entries || [])
      .slice(0, 5)
      .map(video => {
        const track = videoToTrack(video);

        if (!track) {
          return null;
        }

        cacheTrackMetadata(track);
        return {
          name: trimForChoice(`${track.title} - ${track.duration}`),
          value: track.url
        };
      })
      .filter(Boolean);

    setCachedSuggestions(normalizedQuery, suggestions);
    return suggestions;
  } catch {
    return [];
  }
}

function getCachedSuggestions(query) {
  const cached = autocompleteCache.get(query);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > AUTOCOMPLETE_CACHE_TTL_MS) {
    autocompleteCache.delete(query);
    return null;
  }

  return cached.suggestions;
}

function findCachedSuggestions(query) {
  for (const [cachedQuery, cached] of autocompleteCache) {
    if (Date.now() - cached.createdAt > AUTOCOMPLETE_CACHE_TTL_MS) {
      autocompleteCache.delete(cachedQuery);
      continue;
    }

    if (
      query.startsWith(cachedQuery) ||
      cachedQuery.startsWith(query)
    ) {
      return cached.suggestions;
    }
  }

  return null;
}

function setCachedSuggestions(query, suggestions) {
  autocompleteCache.set(query, {
    suggestions,
    createdAt: Date.now()
  });

  while (autocompleteCache.size > AUTOCOMPLETE_CACHE_MAX) {
    autocompleteCache.delete(autocompleteCache.keys().next().value);
  }
}

function videoToTrack(video) {
  const url = normalizeVideoUrl(video);

  if (!url) {
    return null;
  }

  return {
    title: video.title || "Audio sin titulo",
    url,
    duration: formatDuration(video.duration),
    thumbnail: video.thumbnails?.[0]?.url || video.thumbnail || null
  };
}

function normalizeVideoUrl(video) {
  const rawUrl = video?.webpage_url || video?.url || video?.id;

  if (!rawUrl) {
    return null;
  }

  if (isUrl(rawUrl)) {
    return rawUrl;
  }

  if (/^[\w-]{11}$/.test(rawUrl)) {
    return `https://www.youtube.com/watch?v=${rawUrl}`;
  }

  return rawUrl;
}

function getCachedTrackMetadata(url) {
  const cached = trackMetadataCache.get(url);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > AUTOCOMPLETE_CACHE_TTL_MS) {
    trackMetadataCache.delete(url);
    return null;
  }

  return cached.track;
}

function cacheTrackMetadata(track, aliasUrl = null) {
  const urls = [track?.url, aliasUrl].filter(Boolean);

  for (const url of urls) {
    trackMetadataCache.set(url, {
      track: {
        title: track.title,
        url: track.url,
        duration: track.duration,
        thumbnail: track.thumbnail
      },
      createdAt: Date.now()
    });
  }

  while (trackMetadataCache.size > AUTOCOMPLETE_CACHE_MAX) {
    trackMetadataCache.delete(trackMetadataCache.keys().next().value);
  }
}

function withTimeout(promise, timeoutMs, fallback) {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(fallback), timeoutMs);

    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        clearTimeout(timeout);
        resolve(fallback);
      }
    );
  });
}

module.exports = {
  getStreamUrl,
  resolveTrack,
  searchSuggestions
};
