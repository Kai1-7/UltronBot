const fs = require("fs");
const os = require("os");
const path = require("path");
const prism = require("prism-media");
const { PassThrough } = require("stream");
const { createAudioResource, StreamType } = require("@discordjs/voice");

const { config } = require("../config");

const PLAYBACK_AUDIO_BITRATE = "128k";

function waitForPrebuffer(stream, minBytes, timeoutMs) {
  if (stream.readableLength >= minBytes) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const timeout = setTimeout(done, timeoutMs);

    function done() {
      clearTimeout(timeout);
      stream.off("readable", onReadable);
      stream.off("end", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    }

    function onReadable() {
      if (stream.readableLength >= minBytes) {
        done();
      }
    }

    stream.on("readable", onReadable);
    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

async function createTrackResource(source, track) {
  if (isPreparedOpusFile(source)) {
    return createCachedFileResource(source, track);
  }

  return createLiveTranscodedResource(source, track);
}

async function createCachedFileResource(filePath, track) {
  const audioStream = fs.createReadStream(filePath, {
    highWaterMark: 1024 * 1024
  });

  await waitForPrebuffer(
    audioStream,
    Math.min(config.audioPrebufferBytes, 128 * 1024),
    config.audioPrebufferTimeoutMs
  );

  const resource = createAudioResource(audioStream, {
    inputType: StreamType.OggOpus,
    metadata: track
  });

  return { resource, transcoder: audioStream };
}

async function createLiveTranscodedResource(source, track) {
  const transcoder = new prism.FFmpeg({
    args: [
      "-nostdin",
      ...createReconnectArgs(source),
      "-i",
      source,
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
      PLAYBACK_AUDIO_BITRATE,
      "-f",
      "opus"
    ]
  });

  setPlaybackPriority(transcoder.process?.pid);

  const prebufferedStream = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
  transcoder.once("error", error => prebufferedStream.destroy(error));
  transcoder.pipe(prebufferedStream);

  await waitForPrebuffer(
    prebufferedStream,
    config.audioPrebufferBytes,
    config.audioPrebufferTimeoutMs
  );

  const resource = createAudioResource(prebufferedStream, {
    inputType: StreamType.OggOpus,
    metadata: track
  });

  return { resource, transcoder };
}

function isPreparedOpusFile(source) {
  return !/^https?:\/\//i.test(source) && path.extname(source).toLowerCase() === ".opus";
}

function createReconnectArgs(source) {
  if (!/^https?:\/\//i.test(source)) {
    return [];
  }

  return [
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
    "10"
  ];
}

function setPlaybackPriority(pid) {
  if (!pid) {
    return;
  }

  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
  } catch {}
}

module.exports = { createTrackResource };
