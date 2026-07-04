const {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel
} = require("@discordjs/voice");

const { createTrackResource } = require("./createTrackResource");
const { getStreamUrl } = require("./trackResolver");
const { getCachedTrackAudio } = require("./trackCache");

class GuildMusicPlayer {
  constructor(guild, options = {}) {
    this.guild = guild;
    this.queue = [];
    this.currentTrack = null;
    this.connection = null;
    this.subscription = null;
    this.voiceChannelId = null;
    this.disconnectTimer = null;
    this.lastError = null;
    this.activeTranscoder = null;
    this.isProcessing = false;
    this.isSoftReconnecting = false;
    this.skipRequested = false;
    this.loopCurrentTrack = false;
    this.completedTracksSinceReconnect = 0;
    this.softReconnectCount = 0;
    this.lastSoftReconnectAt = null;
    this.lastSoftReconnectReason = null;
    this.lastPrepareMs = null;
    this.lastSourceType = null;
    this.playbackStartedAt = null;
    this.onDestroy = options.onDestroy ?? (() => {});
    this.onTrackEnd = options.onTrackEnd ?? (() => {});
    this.onTrackStart = options.onTrackStart ?? (() => {});
    this.inactivityTimeoutMs = options.inactivityTimeoutMs ?? 120000;
    this.autoReconnectEvery = Math.max(0, options.autoReconnectEvery ?? 10);

    this.player = this.createPlayer();
  }

  createPlayer() {
    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Stop
      }
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      void this.handlePlayerIdle();
    });

    this.player.on("error", error => {
      console.error(`[Audio:${this.guild.name}]`, error);
      this.lastError = error;
      this.notifyTrackEnd(this.currentTrack, "error");
      this.cleanupPlayback();
      this.currentTrack = null;
      this.isProcessing = false;
      void this.processQueue();
    });

    return this.player;
  }

  enqueue(track) {
    this.queue.push(track);
    this.clearDisconnectTimer();
    return this.currentTrack ? this.queue.length + 1 : this.queue.length;
  }

  clearQueue() {
    this.queue = [];
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  getPlaybackMs() {
    const playbackDuration = this.player.state.playbackDuration;

    if (Number.isFinite(playbackDuration)) {
      return playbackDuration;
    }

    return this.playbackStartedAt ? Date.now() - this.playbackStartedAt : 0;
  }

  isLoopingCurrentTrack() {
    return Boolean(this.loopCurrentTrack && this.currentTrack);
  }

  setLoopCurrentTrack(enabled) {
    this.loopCurrentTrack = Boolean(enabled && this.currentTrack);
    return this.loopCurrentTrack;
  }

  toggleLoopCurrentTrack() {
    return this.setLoopCurrentTrack(!this.loopCurrentTrack);
  }

  skip() {
    this.skipRequested = true;
    this.loopCurrentTrack = false;
    this.player.stop(true);
  }

  stop() {
    this.notifyTrackEnd(this.currentTrack, "stopped");
    this.queue = [];
    this.loopCurrentTrack = false;
    this.cleanupPlayback();
    this.currentTrack = null;
    this.isProcessing = false;
    this.skipRequested = true;
    this.player.stop(true);
    this.destroy();
  }

  async connect(voiceChannel) {
    this.voiceChannelId = voiceChannel.id;

    if (this.canReuseConnection(voiceChannel)) {
      return this.connection;
    }

    if (this.connection) {
      this.destroyConnection(this.connection);
    }

    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    this.connection = connection;
    this.subscription = connection.subscribe(this.player);

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.connection !== connection) {
        return;
      }

      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch {
        if (this.connection === connection) {
          this.destroy();
        }
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.connection === connection) {
        this.connection = null;
        this.subscription = null;
      }
    });

    connection.on("error", error => {
      console.error(`[Voice:${this.guild.name}]`, error);
      this.lastError = error;

      if (this.connection === connection) {
        this.destroy();
      }
    });

    return connection;
  }

  async handlePlayerIdle() {
    const finishedTrack = this.currentTrack;
    const completedNaturally = Boolean(finishedTrack && !this.skipRequested);
    const shouldLoopTrack = Boolean(completedNaturally && this.loopCurrentTrack);

    this.notifyTrackEnd(finishedTrack, shouldLoopTrack ? "looped" : completedNaturally ? "finished" : "skipped");
    this.cleanupPlayback();
    this.currentTrack = null;
    this.playbackStartedAt = null;
    this.isProcessing = false;

    if (completedNaturally) {
      this.completedTracksSinceReconnect++;
    }

    this.skipRequested = false;

    if (shouldLoopTrack) {
      this.queue.unshift(createLoopTrack(finishedTrack));
    }

    if (this.shouldSoftReconnectBeforeNext()) {
      await this.softReconnect("auto");
    }

    void this.processQueue();
  }

  shouldSoftReconnectBeforeNext() {
    return Boolean(
      this.autoReconnectEvery > 0 &&
      this.completedTracksSinceReconnect >= this.autoReconnectEvery &&
      this.queue.length > 0 &&
      this.connection &&
      !this.isSoftReconnecting
    );
  }

  async softReconnect(reason = "manual") {
    if (this.isSoftReconnecting) {
      return false;
    }

    const channel = await this.resolveVoiceChannel();

    if (!channel) {
      console.warn(`[Voice:${this.guild.name}] No pude reconectar: canal de voz no disponible.`);
      return false;
    }

    this.isSoftReconnecting = true;

    try {
      console.log(`[Voice:${this.guild.name}] Soft reconnect iniciado reason=${reason}.`);

      this.cleanupPlayback();

      if (this.connection) {
        this.destroyConnection(this.connection);
      }

      this.replaceAudioPlayer();
      await this.connect(channel);

      const ready = await this.ensureVoiceReady();

      if (!ready) {
        throw new Error("La nueva conexion de voz no llego a Ready.");
      }

      this.completedTracksSinceReconnect = 0;
      this.softReconnectCount++;
      this.lastSoftReconnectAt = new Date().toISOString();
      this.lastSoftReconnectReason = reason;
      this.lastError = null;
      console.log(`[Voice:${this.guild.name}] Soft reconnect completado.`);
      return true;
    } catch (error) {
      console.error(`[Voice:${this.guild.name}] Soft reconnect fallo`, error);
      this.lastError = error;
      return false;
    } finally {
      this.isSoftReconnecting = false;
    }
  }

  replaceAudioPlayer() {
    const oldPlayer = this.player;

    if (oldPlayer) {
      oldPlayer.removeAllListeners();

      try {
        oldPlayer.stop(true);
      } catch {}
    }

    this.player = this.createPlayer();
  }

  async resolveVoiceChannel() {
    const channelId = this.voiceChannelId ?? this.connection?.joinConfig?.channelId;

    if (!channelId) {
      return null;
    }

    const cachedChannel = this.guild.channels.cache.get(channelId);

    if (cachedChannel?.isVoiceBased?.()) {
      return cachedChannel;
    }

    const fetchedChannel = await this.guild.channels.fetch(channelId).catch(() => null);
    return fetchedChannel?.isVoiceBased?.() ? fetchedChannel : null;
  }

  canReuseConnection(voiceChannel) {
    if (!this.connection || this.connection.joinConfig.channelId !== voiceChannel.id) {
      return false;
    }

    return [
      VoiceConnectionStatus.Ready,
      VoiceConnectionStatus.Signalling,
      VoiceConnectionStatus.Connecting
    ].includes(this.connection.state.status);
  }

  async ensureVoiceReady() {
    const connection = this.connection;

    if (!connection) {
      return false;
    }

    if (connection.state.status === VoiceConnectionStatus.Ready) {
      return true;
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      return true;
    } catch (error) {
      console.error(`[Voice:${this.guild.name}] La conexion no llego a Ready`, error);
      this.lastError = error;

      if (this.connection === connection) {
        this.destroyConnection(connection);
      }

      return false;
    }
  }

  async processQueue() {
    if (this.isProcessing || this.currentTrack || !this.connection) {
      return;
    }

    const nextTrack = this.queue.shift();

    if (!nextTrack) {
      this.scheduleDisconnect();
      return;
    }

    this.isProcessing = true;
    this.currentTrack = nextTrack;
    this.clearDisconnectTimer();

    try {
      const isReady = await this.ensureVoiceReady();

      if (!isReady) {
        throw new Error("La conexion de voz no estuvo lista a tiempo.");
      }

      const prepareStartedAt = Date.now();
      const audioSource = await this.prepareAudioSource(nextTrack);
      const prepareMs = Date.now() - prepareStartedAt;
      const sourceType = audioSource.endsWith(".opus") ? "cache" : "live";
      const { resource, transcoder } = await createTrackResource(audioSource, nextTrack);

      this.cleanupPlayback();
      this.activeTranscoder = transcoder;
      this.lastPrepareMs = prepareMs;
      this.lastSourceType = sourceType;
      this.playbackStartedAt = Date.now();
      this.player.play(resource);
      this.notifyTrackStart(nextTrack);
      console.log(
        `[Playback:${this.guild.name}] Reproduciendo "${nextTrack.title}" ` +
          `source=${sourceType} prepareMs=${prepareMs}`
      );
      this.lastError = null;
    } catch (error) {
      console.error(`[Playback:${this.guild.name}]`, error);
      this.lastError = error;
      this.cleanupPlayback();
      this.notifyTrackEnd(this.currentTrack, "error");
      this.currentTrack = null;
      this.playbackStartedAt = null;
    } finally {
      this.isProcessing = false;
    }

    if (!this.currentTrack) {
      await this.processQueue();
    }
  }

  getStats() {
    const voicePing = this.connection?.ping ?? {};
    const playerState = this.player.state;
    const networkingState = this.connection?.state?.networking?.state;
    const connectionOptions = networkingState?.connectionOptions;
    const connectionData = networkingState?.connectionData;
    const udpRemote = networkingState?.udp?.remote;

    return {
      guildId: this.guild.id,
      guildName: this.guild.name,
      playerStatus: playerState.status,
      connectionStatus: this.connection?.state.status ?? null,
      channelId: this.connection?.joinConfig?.channelId ?? null,
      voiceEndpoint: connectionOptions?.endpoint ?? null,
      udpRemote: udpRemote
        ? {
            ip: udpRemote.ip ?? null,
            port: toInteger(udpRemote.port)
          }
        : null,
      voicePingMs: {
        ws: toFiniteNumber(voicePing.ws),
        udp: toFiniteNumber(voicePing.udp)
      },
      voicePacketsPlayed: toInteger(connectionData?.packetsPlayed),
      voiceSequence: toInteger(connectionData?.sequence),
      voiceSpeaking: typeof connectionData?.speaking === "boolean" ? connectionData.speaking : null,
      subscriberCount: this.player.subscribers?.length ?? null,
      audioPlaybackDurationMs: toInteger(playerState.playbackDuration),
      audioMissedFrames: toInteger(playerState.missedFrames),
      autoReconnectEvery: this.autoReconnectEvery,
      completedTracksSinceReconnect: this.completedTracksSinceReconnect,
      loopCurrentTrack: this.isLoopingCurrentTrack(),
      isSoftReconnecting: Boolean(this.isSoftReconnecting),
      softReconnectCount: this.softReconnectCount,
      lastSoftReconnectAt: this.lastSoftReconnectAt,
      lastSoftReconnectReason: this.lastSoftReconnectReason,
      sourceType: this.currentTrack ? this.lastSourceType : null,
      lastPrepareMs: this.lastPrepareMs,
      playbackSeconds: this.playbackStartedAt ? Math.floor((Date.now() - this.playbackStartedAt) / 1000) : null,
      currentTrack: this.currentTrack
        ? {
            title: this.currentTrack.title,
            duration: this.currentTrack.duration,
            url: this.currentTrack.url
          }
        : null,
      queueLength: this.queue.length,
      lastError: this.lastError?.message ?? null
    };
  }

  scheduleDisconnect() {
    this.clearDisconnectTimer();

    this.disconnectTimer = setTimeout(() => {
      void this.handleInactivityTimeout();
    }, this.inactivityTimeoutMs);
  }

  async handleInactivityTimeout() {
    this.disconnectTimer = null;

    if (this.currentTrack || this.queue.length > 0) {
      return;
    }

    const channel = await this.resolveVoiceChannel();

    if (hasHumanVoiceMembers(channel)) {
      this.scheduleDisconnect();
      return;
    }

    this.destroy();
  }

  clearDisconnectTimer() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  cleanupPlayback() {
    if (!this.activeTranscoder) {
      return;
    }

    try {
      this.activeTranscoder.destroy();
    } catch {}

    this.activeTranscoder = null;
  }

  notifyTrackStart(track) {
    if (!track) {
      return;
    }

    Promise.resolve(this.onTrackStart(this, track)).catch(error => {
      console.error(`[Playback:${this.guild.name}] No pude publicar panel de musica`, error);
    });
  }

  notifyTrackEnd(track, reason) {
    if (!track) {
      return;
    }

    Promise.resolve(this.onTrackEnd(this, track, reason)).catch(error => {
      console.error(`[Playback:${this.guild.name}] No pude cerrar panel de musica`, error);
    });
  }

  async prepareAudioSource(track) {
    try {
      const cachedAudio = await getCachedTrackAudio(track);

      if (cachedAudio) {
        return cachedAudio;
      }
    } catch (error) {
      console.warn(`[Cache:${this.guild.name}] No pude revisar cache, usando stream directo.`, error);
      this.lastError = error;
    }

    return getStreamUrl(track.url);
  }

  destroyConnection(connection) {
    if (!connection) {
      return;
    }

    if (this.subscription) {
      try {
        this.subscription.unsubscribe();
      } catch {}

      this.subscription = null;
    }

    if (this.connection === connection) {
      this.connection = null;
    }

    try {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
    } catch {}
  }

  destroy() {
    this.clearDisconnectTimer();
    this.cleanupPlayback();
    this.notifyTrackEnd(this.currentTrack, "destroyed");
    this.queue = [];
    this.currentTrack = null;
    this.isProcessing = false;
    this.skipRequested = true;
    this.loopCurrentTrack = false;
    this.player.stop(true);
    this.clearDisconnectTimer();

    if (this.connection) {
      this.destroyConnection(this.connection);
    }

    this.voiceChannelId = null;
    this.onDestroy(this.guild.id);
  }
}

function toFiniteNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

function createLoopTrack(track) {
  return {
    ...track,
    controlToken: null,
    currentSubtitleLine: track.syncedLyricsEnabled ? "Esperando la siguiente linea..." : null
  };
}

function toInteger(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function hasHumanVoiceMembers(channel) {
  return (channel?.members?.filter(member => !member.user.bot).size ?? 0) > 0;
}

module.exports = { GuildMusicPlayer };
