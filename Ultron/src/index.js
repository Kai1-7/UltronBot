const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits
} = require("discord.js");

const { commandBuilders, slashCommands } = require("./commands");
const { config } = require("./config");
const { installDiscordGatewayFallback } = require("./discordGatewayFallback");
const { startHealthServer } = require("./health");
const { setPlayerStatsProvider, startMetricsLogger, startRealtimeMonitor } = require("./metrics");
const { GuildMusicPlayer } = require("./music/GuildMusicPlayer");
const { cacheTrackAudio } = require("./music/trackCache");
const { findOriginalLyrics, findSpanishLyrics, findSyncedSpanishLyrics } = require("./music/lyrics");
const { resolveTrack, searchSuggestions } = require("./music/trackResolver");

installDiscordGatewayFallback();
startHealthServer(config.port);
startMetricsLogger();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  rest: {
    timeout: 30_000,
    retries: 5
  }
});

const guildPlayers = new Map();
const activeMusicPanels = new Map();
const activeSubtitleSessions = new Map();
const activePanelRefreshSessions = new Map();
let isDiscordReady = false;

const MUSIC_BUTTON_IDS = {
  togglePause: "toggle-pause",
  skip: "skip",
  stop: "stop",
  loop: "loop",
  lyrics: "lyrics",
  syncedLyrics: "synced-lyrics"
};

const SUBTITLE_UPDATE_INTERVAL_MS = 2500;
const PANEL_REFRESH_INTERVAL_MS = 15000;
const PROGRESS_BAR_SEGMENTS = 18;
const PANEL_MOTION_FRAMES = [
  "[=     ]",
  "[==    ]",
  "[===   ]",
  "[ ===  ]",
  "[  === ]",
  "[   ===]",
  "[    ==]",
  "[     =]",
  "[    ==]",
  "[   ===]",
  "[  === ]",
  "[ ===  ]"
];

setPlayerStatsProvider(() => Array.from(guildPlayers.values()).map(player => player.getStats()));
startRealtimeMonitor();

function getGuildPlayer(guild) {
  if (!guildPlayers.has(guild.id)) {
    guildPlayers.set(
      guild.id,
      new GuildMusicPlayer(guild, {
        inactivityTimeoutMs: config.inactivityTimeoutMs,
        autoReconnectEvery: config.voiceReconnectEvery,
        onDestroy: guildId => {
          void disableActiveMusicPanel(guildId);
          guildPlayers.delete(guildId);
        },
        onTrackEnd: (_player, track) => disableActiveMusicPanel(guild.id, track.controlToken),
        onTrackStart: (player, track) => publishActiveMusicPanel(player, track)
      })
    );
  }

  return guildPlayers.get(guild.id);
}

async function registerSlashCommands(readyClient) {
  if (config.guildId) {
    const guild = await readyClient.guilds.fetch(config.guildId);
    await guild.commands.set(slashCommands);
    console.log(`Comandos registrados en el servidor ${guild.name}.`);
    return;
  }

  await readyClient.application.commands.set(slashCommands);
  console.log("Comandos globales registrados correctamente.");
}

async function fetchBotMember(guild) {
  return guild.members.me ?? guild.members.cache.get(guild.client.user.id) ?? guild.members.fetchMe();
}

async function ensureUserVoiceChannel(interaction) {
  const voiceChannel = interaction.member?.voice?.channel ?? null;

  if (!voiceChannel) {
    await interaction.reply("Debes estar en un canal de voz para usar este comando.");
    return null;
  }

  return voiceChannel;
}

async function ensureBotCanJoin(interaction, voiceChannel, botMember = null) {
  const me = botMember ?? await fetchBotMember(interaction.guild);
  const permissions = voiceChannel.permissionsFor(me);

  if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) {
    const message = "Necesito permisos de conectar y hablar en ese canal de voz.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    } else {
      await interaction.reply(message);
    }

    return false;
  }

  return true;
}

async function ensureSameVoiceChannel(interaction) {
  const voiceChannel = await ensureUserVoiceChannel(interaction);

  if (!voiceChannel) {
    return null;
  }

  const me = await fetchBotMember(interaction.guild);
  const botChannel = me.voice?.channel;

  if (botChannel && botChannel.id !== voiceChannel.id) {
    await interaction.reply("Debes estar en el mismo canal de voz que el bot para controlar la reproduccion.");
    return null;
  }

  return voiceChannel;
}

function createTrackEmbed(title, track, color, options = {}) {
  const player = options.player ?? null;
  const progressLine = player ? createProgressLine(player, track) : null;
  const motionFrame = player ? options.motionFrame || getPanelMotionFrame(player.guild.id) : null;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(`**${track.title}**`)
    .addFields(
      { name: "Duracion", value: track.duration, inline: true },
      { name: "Pedido por", value: track.requestedBy, inline: true }
    )
    .setURL(track.url)
    .setTimestamp();

  if (player) {
    embed.addFields(
      { name: "Estado", value: createPlaybackStatus(player), inline: true },
      { name: "Cola", value: `${player.queue.length} pendiente${player.queue.length === 1 ? "" : "s"}`, inline: true },
      { name: "Pulso", value: motionFrame, inline: true }
    );
  }

  if (progressLine) {
    embed.addFields({
      name: "Progreso",
      value: progressLine
    });
  }

  if (track.syncedLyricsEnabled) {
    embed.addFields({
      name: "Subtitulo",
      value: trimForEmbedField(track.currentSubtitleLine || "Esperando la siguiente linea...")
    });
  }

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  embed.setFooter({
    text: player ? "Panel en vivo - se actualiza automaticamente" : "Ultron Music"
  });

  return embed;
}

function createPlaybackStatus(player) {
  const state = player.isPaused() ? "Pausado" : "Reproduciendo";
  const loop = player.isLoopingCurrentTrack() ? "Loop ON" : "Loop OFF";
  const source = player.lastSourceType === "cache" ? "Cache local" : player.lastSourceType === "live" ? "Stream directo" : "Preparando";

  return `${state} | ${loop} | ${source}`;
}

function createProgressLine(player, track) {
  const durationMs = parseDurationToMs(track.duration);
  const playbackMs = Math.max(0, player.getPlaybackMs());

  if (!durationMs) {
    return `${createLiveProgressBar(playbackMs)}\n${formatPlaybackTime(playbackMs)} / En vivo`;
  }

  const clampedPlaybackMs = Math.min(playbackMs, durationMs);
  const ratio = durationMs > 0 ? clampedPlaybackMs / durationMs : 0;
  const filledSegments = Math.max(0, Math.min(PROGRESS_BAR_SEGMENTS, Math.round(ratio * PROGRESS_BAR_SEGMENTS)));
  const emptySegments = PROGRESS_BAR_SEGMENTS - filledSegments;
  const percent = Math.round(ratio * 100);
  const bar = `[${"#".repeat(filledSegments)}${"-".repeat(emptySegments)}]`;

  return `${bar} ${percent}%\n${formatPlaybackTime(clampedPlaybackMs)} / ${track.duration}`;
}

function createLiveProgressBar(playbackMs) {
  const filledSegments = Math.floor(playbackMs / PANEL_REFRESH_INTERVAL_MS) % PROGRESS_BAR_SEGMENTS;
  return `[${"#".repeat(filledSegments)}${"-".repeat(PROGRESS_BAR_SEGMENTS - filledSegments)}]`;
}

function parseDurationToMs(value) {
  const parts = String(value || "")
    .split(":")
    .map(part => Number(part));

  if (parts.length > 3 || parts.some(part => !Number.isFinite(part))) {
    return null;
  }

  if (parts.length === 1) {
    return parts[0] * 1000;
  }

  return parts.reduce((total, part) => (total * 60) + part, 0) * 1000;
}

function formatPlaybackTime(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getPanelMotionFrame(guildId) {
  const session = activePanelRefreshSessions.get(guildId);
  return PANEL_MOTION_FRAMES[session?.frameIndex ?? 0] || PANEL_MOTION_FRAMES[0];
}

function createMusicControls(player, options = {}) {
  const hasTrack = Boolean(player?.currentTrack || options.enabled);
  const paused = Boolean(player?.isPaused?.());
  const looping = Boolean(player?.isLoopingCurrentTrack?.());
  const disabled = Boolean(options.disabled || !hasTrack);
  const lyricsUnavailable = Boolean(options.lyricsUnavailable ?? player?.currentTrack?.lyricsUnavailable);
  const syncedLyricsUnavailable = Boolean(player?.currentTrack?.syncedLyricsUnavailable);
  const syncedLyricsEnabled = Boolean(player?.currentTrack?.syncedLyricsEnabled);
  const token = options.token || player?.currentTrack?.controlToken || "none";

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(createMusicButtonId(MUSIC_BUTTON_IDS.togglePause, token))
        .setEmoji(paused ? "▶️" : "⏸️")
        .setLabel(paused ? "Reanudar" : "Pausar")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(createMusicButtonId(MUSIC_BUTTON_IDS.skip, token))
        .setEmoji("⏭️")
        .setLabel("Skip")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(createMusicButtonId(MUSIC_BUTTON_IDS.stop, token))
        .setEmoji("⏹️")
        .setLabel("Stop")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(createMusicButtonId(MUSIC_BUTTON_IDS.loop, token))
        .setEmoji("🔁")
        .setLabel(looping ? "Loop ON" : "Loop")
        .setStyle(looping ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(createMusicButtonId(MUSIC_BUTTON_IDS.lyrics, token))
        .setEmoji("📜")
        .setLabel(lyricsUnavailable ? "Sin letra ES" : "Letra ES")
        .setStyle(lyricsUnavailable ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(createMusicButtonId(MUSIC_BUTTON_IDS.syncedLyrics, token))
        .setEmoji("🎤")
        .setLabel(syncedLyricsUnavailable ? "Sin sync" : syncedLyricsEnabled ? "Sync ON" : "Sync ES")
        .setStyle(syncedLyricsUnavailable ? ButtonStyle.Danger : syncedLyricsEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(disabled)
    )
  ];
}

function createMusicButtonId(action, token) {
  return `music:${action}:${token}`;
}

function parseMusicButtonId(customId) {
  const [, action, token] = String(customId || "").split(":");
  return { action, token };
}

function createControlToken() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function publishActiveMusicPanel(player, track) {
  if (!track?.textChannelId) {
    return;
  }

  if (!track.controlToken) {
    track.controlToken = createControlToken();
  }

  await disableActiveMusicPanel(player.guild.id);

  const channel = await resolveTextChannel(player.guild, track.textChannelId);

  if (!channel) {
    return;
  }

  if (player.currentTrack?.controlToken !== track.controlToken) {
    return;
  }

  const embed = createTrackEmbed("Ahora suena", track, 0x2ecc71, { player });
  const message = await channel.send({
    embeds: [embed],
    components: createMusicControls(player),
    allowedMentions: { parse: [] }
  });

  if (player.currentTrack?.controlToken !== track.controlToken) {
    await message
      .edit({
        components: createMusicControls(null, {
          disabled: true,
          token: track.controlToken
        })
      })
      .catch(() => {});
    return;
  }

  activeMusicPanels.set(player.guild.id, {
    channelId: channel.id,
    messageId: message.id,
    token: track.controlToken
  });
  startPanelRefreshSession(player, track.controlToken);

  if (track.syncedLyricsEnabled && Array.isArray(track.syncedLyricsLines) && track.syncedLyricsLines.length > 0) {
    startSubtitleSession(player, track.syncedLyricsLines);
  }
}

async function disableActiveMusicPanel(guildId, token = null) {
  stopPanelRefreshSession(guildId, token);
  stopSubtitleSession(guildId, token);

  const panel = activeMusicPanels.get(guildId);

  if (!panel || (token && panel.token !== token)) {
    return;
  }

  if (activeMusicPanels.get(guildId)?.token === panel.token) {
    activeMusicPanels.delete(guildId);
  }

  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
  const channel = guild ? await resolveTextChannel(guild, panel.channelId) : null;
  const message = await channel?.messages?.fetch(panel.messageId).catch(() => null);

  await message
    ?.edit({
      components: createMusicControls(null, {
        disabled: true,
        token: panel.token
      })
    })
    .catch(() => {});
}

async function updateActiveMusicPanelControls(player) {
  const panel = activeMusicPanels.get(player.guild.id);

  if (!panel || panel.token !== player.currentTrack?.controlToken) {
    return;
  }

  const channel = await resolveTextChannel(player.guild, panel.channelId);
  const message = await channel?.messages?.fetch(panel.messageId).catch(() => null);

  await message
    ?.edit({
      embeds: [createTrackEmbed("Ahora suena", player.currentTrack, 0x2ecc71, { player })],
      components: createMusicControls(player)
    })
    .catch(() => {});
}

function startPanelRefreshSession(player, token) {
  stopPanelRefreshSession(player.guild.id);

  const session = {
    token,
    frameIndex: 0,
    timer: setInterval(() => {
      void refreshActiveMusicPanel(player.guild.id);
    }, PANEL_REFRESH_INTERVAL_MS)
  };

  session.timer.unref?.();
  activePanelRefreshSessions.set(player.guild.id, session);
}

function stopPanelRefreshSession(guildId, token = null) {
  const session = activePanelRefreshSessions.get(guildId);

  if (!session || (token && session.token !== token)) {
    return;
  }

  clearInterval(session.timer);
  activePanelRefreshSessions.delete(guildId);
}

async function refreshActiveMusicPanel(guildId) {
  const session = activePanelRefreshSessions.get(guildId);
  const player = guildPlayers.get(guildId);
  const track = player?.currentTrack;

  if (!session || !player || !track || track.controlToken !== session.token) {
    stopPanelRefreshSession(guildId, session?.token);
    return;
  }

  session.frameIndex = (session.frameIndex + 1) % PANEL_MOTION_FRAMES.length;
  await updateActiveMusicPanelControls(player);
}

function stopSubtitleSession(guildId, token = null) {
  const session = activeSubtitleSessions.get(guildId);

  if (!session || (token && session.token !== token)) {
    return;
  }

  clearInterval(session.timer);
  activeSubtitleSessions.delete(guildId);
}

function startSubtitleSession(player, lines) {
  const track = player.currentTrack;

  if (!track?.controlToken || !Array.isArray(lines) || lines.length === 0) {
    return;
  }

  stopSubtitleSession(player.guild.id);

  activeSubtitleSessions.set(player.guild.id, {
    token: track.controlToken,
    lines,
    lastIndex: -2,
    timer: setInterval(() => {
      void updateSubtitleLine(player.guild.id);
    }, SUBTITLE_UPDATE_INTERVAL_MS)
  });

  void updateSubtitleLine(player.guild.id);
}

async function updateSubtitleLine(guildId) {
  const session = activeSubtitleSessions.get(guildId);
  const player = guildPlayers.get(guildId);
  const track = player?.currentTrack;

  if (!session || !player || !track || track.controlToken !== session.token || !track.syncedLyricsEnabled) {
    stopSubtitleSession(guildId, session?.token);
    return;
  }

  const playbackMs = player.getPlaybackMs();
  const lineIndex = findSubtitleLineIndex(session.lines, playbackMs);

  if (lineIndex === session.lastIndex) {
    return;
  }

  session.lastIndex = lineIndex;
  track.currentSubtitleLine = lineIndex >= 0 ? session.lines[lineIndex].text : "Esperando la siguiente linea...";
  await updateActiveMusicPanelControls(player);
}

function findSubtitleLineIndex(lines, playbackMs) {
  let currentIndex = -1;

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].timeMs > playbackMs) {
      break;
    }

    currentIndex = index;
  }

  return currentIndex;
}

async function resolveTextChannel(guild, channelId) {
  if (!channelId) {
    return null;
  }

  const cachedChannel = guild.channels.cache.get(channelId);
  const channel = cachedChannel ?? (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel?.isTextBased?.() || typeof channel.send !== "function") {
    return null;
  }

  return channel;
}

client.once("clientReady", async readyClient => {
  isDiscordReady = true;
  console.log(`Bot listo como ${readyClient.user.tag}`);

  try {
    const registered = await withTimeout(registerSlashCommands(readyClient), 15_000, false);

    if (!registered) {
      console.warn("Registro de comandos sigue pendiente por lentitud de Discord API; el bot queda activo.");
    }
  } catch (error) {
    console.error("No pude registrar los comandos slash:", error);
  }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isAutocomplete()) {
    const focused = interaction.options.getFocused().trim();

    if (focused.length < 2) {
      await interaction.respond([]);
      return;
    }

    try {
      const choices = await searchSuggestions(focused);
      await interaction.respond(choices);
    } catch (error) {
      console.error("Error en autocomplete:", error);
      await interaction.respond([]).catch(() => {});
    }

    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("music:")) {
    try {
      await handleMusicButton(interaction);
    } catch (error) {
      console.error(`Error ejecutando boton ${interaction.customId}:`, error);
      await replyToFailedInteraction(interaction, "Hubo un error usando ese boton.");
    }

    return;
  }

  if (!interaction.isChatInputCommand() || !interaction.inGuild()) {
    return;
  }

  try {
    switch (interaction.commandName) {
      case "play":
        await handlePlay(interaction);
        break;
      case "preload":
        await handlePreload(interaction);
        break;
      case "skip":
        await handleSkip(interaction);
        break;
      case "stop":
        await handleStop(interaction);
        break;
      case "pause":
        await handlePause(interaction);
        break;
      case "resume":
        await handleResume(interaction);
        break;
      case "queue":
        await handleQueue(interaction);
        break;
      case "clear":
        await handleClear(interaction);
        break;
      case "nowplaying":
        await handleNowPlaying(interaction);
        break;
      case "help":
        await handleHelp(interaction);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error(`Error ejecutando /${interaction.commandName}:`, error);

    const message = error?.message || "Hubo un error ejecutando el comando.";
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

function hasHumanMembers(channel) {
  return (channel?.members?.filter(member => !member.user.bot).size ?? 0) > 0;
}

client.on("voiceStateUpdate", (oldState, newState) => {
  const guildId = oldState.guild.id;
  const player = guildPlayers.get(guildId);

  if (!player) {
    return;
  }

  if (oldState.member?.id === client.user?.id) {
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      player.destroy();
    }

    return;
  }

  const botChannelId = player.connection?.joinConfig.channelId;

  if (!botChannelId) {
    return;
  }

  const affectedChannel =
    oldState.channel?.id === botChannelId
      ? oldState.channel
      : newState.channel?.id === botChannelId
        ? newState.channel
        : null;

  if (affectedChannel && !hasHumanMembers(affectedChannel)) {
    player.destroy();
  }
});

async function handleMusicButton(interaction) {
  const { action, token } = parseMusicButtonId(interaction.customId);

  switch (action) {
    case MUSIC_BUTTON_IDS.togglePause:
      await handleTogglePauseButton(interaction, token);
      break;
    case MUSIC_BUTTON_IDS.skip:
      await handleSkipButton(interaction, token);
      break;
    case MUSIC_BUTTON_IDS.stop:
      await handleStopButton(interaction, token);
      break;
    case MUSIC_BUTTON_IDS.loop:
      await handleLoopButton(interaction, token);
      break;
    case MUSIC_BUTTON_IDS.lyrics:
      await handleLyricsButton(interaction, token);
      break;
    case MUSIC_BUTTON_IDS.syncedLyrics:
      await handleSyncedLyricsButton(interaction, token);
      break;
    default:
      await interaction.reply({ content: "Ese boton ya no esta disponible.", ephemeral: true });
      break;
  }
}

async function handleTogglePauseButton(interaction, token) {
  const context = await ensureMusicButtonControl(interaction, token);

  if (!context) {
    return;
  }

  const { player } = context;
  const changed = player.isPaused() ? player.resume() : player.pause();

  if (!changed) {
    await interaction.reply({
      content: "No pude cambiar el estado de la reproduccion ahora mismo.",
      ephemeral: true
    });
    return;
  }

  await interaction.update({ components: createMusicControls(player) });
  await updateActiveMusicPanelControls(player);
}

async function handleSkipButton(interaction, token) {
  const context = await ensureMusicButtonControl(interaction, token);

  if (!context) {
    return;
  }

  const { player } = context;
  const title = player.currentTrack.title;
  player.skip();

  await interaction.reply({
    content: `Saltando **${title}**.`,
    ephemeral: true,
    allowedMentions: { parse: [] }
  });
}

async function handleStopButton(interaction, token) {
  const context = await ensureMusicButtonControl(interaction, token);

  if (!context) {
    return;
  }

  await interaction.update({
    content: "Reproduccion detenida.",
    components: createMusicControls(null, {
      disabled: true,
      token: token || context.player.currentTrack?.controlToken || "stopped"
    })
  });

  context.player.stop();
}

async function handleLoopButton(interaction, token) {
  const context = await ensureMusicButtonControl(interaction, token);

  if (!context) {
    return;
  }

  const { player } = context;
  player.toggleLoopCurrentTrack();

  await interaction.update({
    embeds: [createTrackEmbed("Ahora suena", player.currentTrack, 0x2ecc71, { player })],
    components: createMusicControls(player)
  });
  await updateActiveMusicPanelControls(player);
}

async function handleLyricsButton(interaction, token) {
  const context = await ensureMusicButtonControl(interaction, token);

  if (!context) {
    return;
  }

  const { player } = context;
  const track = player.currentTrack;

  await interaction.deferReply({ ephemeral: true });

  const lyrics = await findSpanishLyrics(track);

  if (!lyrics) {
    const originalLyrics = await findOriginalLyrics(track);

    await markLyricsUnavailable(interaction, player);
    await interaction.editReply({
      content: originalLyrics
        ? "Encontre letra para esta cancion, pero no pude convertirla a espanol en este momento."
        : "No encontre letra para esta cancion.",
      allowedMentions: { parse: [] }
    });
    return;
  }

  track.lyricsUnavailable = false;
  await updateActiveMusicPanelControls(player);

  await interaction.editReply({
    embeds: createLyricsEmbeds(track, lyrics),
    allowedMentions: { parse: [] }
  });
}

async function handleSyncedLyricsButton(interaction, token) {
  const context = await ensureMusicButtonControl(interaction, token);

  if (!context) {
    return;
  }

  const { player } = context;
  const track = player.currentTrack;

  if (track.syncedLyricsEnabled) {
    stopSubtitleSession(interaction.guild.id, track.controlToken);
    track.syncedLyricsEnabled = false;
    track.syncedLyricsLines = null;
    track.currentSubtitleLine = null;

    await interaction.update({
      embeds: [createTrackEmbed("Ahora suena", track, 0x2ecc71, { player })],
      components: createMusicControls(player)
    });
    await updateActiveMusicPanelControls(player);
    return;
  }

  track.syncedLyricsEnabled = true;
  track.syncedLyricsUnavailable = false;
  track.syncedLyricsLines = null;
  track.currentSubtitleLine = "Cargando subtitulos...";

  await interaction.update({
    embeds: [createTrackEmbed("Ahora suena", track, 0x2ecc71, { player })],
    components: createMusicControls(player)
  });
  await updateActiveMusicPanelControls(player);

  const syncedLyrics = await findSyncedSpanishLyrics(track);

  if (!syncedLyrics?.lines?.length) {
    stopSubtitleSession(interaction.guild.id, track.controlToken);
    track.syncedLyricsEnabled = false;
    track.syncedLyricsUnavailable = true;
    track.syncedLyricsLines = null;
    track.currentSubtitleLine = null;

    await interaction.message
      .edit({
        embeds: [createTrackEmbed("Ahora suena", track, 0x2ecc71, { player })],
        components: createMusicControls(player)
      })
      .catch(() => {});
    await updateActiveMusicPanelControls(player);
    await interaction.followUp({
      content: "No encontre letra sincronizada para esta cancion.",
      ephemeral: true
    });
    return;
  }

  if (player.currentTrack?.controlToken !== track.controlToken) {
    return;
  }

  track.syncedLyricsUnavailable = false;
  track.syncedLyricsLines = syncedLyrics.lines;
  track.currentSubtitleLine = "Esperando la siguiente linea...";
  startSubtitleSession(player, track.syncedLyricsLines);

  await interaction.message
    .edit({
      embeds: [createTrackEmbed("Ahora suena", track, 0x2ecc71, { player })],
      components: createMusicControls(player)
    })
    .catch(() => {});
  await updateActiveMusicPanelControls(player);
}

async function ensureMusicButtonControl(interaction, token) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Ese boton solo funciona dentro del servidor.", ephemeral: true });
    return null;
  }

  const player = guildPlayers.get(interaction.guild.id);

  if (!player?.currentTrack) {
    await interaction.reply({ content: "No hay ninguna cancion sonando.", ephemeral: true });
    return null;
  }

  if (player.currentTrack.controlToken && token !== player.currentTrack.controlToken) {
    await disableInteractionMusicPanel(interaction, token);
    await interaction.reply({
      content: "Ese panel es de una cancion anterior. Usa el panel mas reciente.",
      ephemeral: true
    });
    return null;
  }

  const voiceChannel = interaction.member?.voice?.channel ?? null;

  if (!voiceChannel) {
    await interaction.reply({
      content: "Debes estar en un canal de voz para usar los controles.",
      ephemeral: true
    });
    return null;
  }

  const me = await fetchBotMember(interaction.guild);
  const botChannel = me.voice?.channel;

  if (botChannel && botChannel.id !== voiceChannel.id) {
    await interaction.reply({
      content: "Debes estar en el mismo canal de voz que el bot para usar los controles.",
      ephemeral: true
    });
    return null;
  }

  return { player, voiceChannel };
}

async function disableInteractionMusicPanel(interaction, token) {
  await interaction.message
    .edit({
      components: createMusicControls(null, {
        disabled: true,
        token: token || "stale"
      })
    })
    .catch(() => {});
}

async function markLyricsUnavailable(interaction, player) {
  if (player.currentTrack) {
    player.currentTrack.lyricsUnavailable = true;
  }

  await interaction.message
    .edit({
      components: createMusicControls(player, { lyricsUnavailable: true })
    })
    .catch(() => {});

  await updateActiveMusicPanelControls(player);
}

function createLyricsEmbeds(track, lyricsResult) {
  const { chunks, truncated } = splitLyricsForDiscord(lyricsResult.lyrics);
  const footer = `${lyricsResult.source}${truncated ? " - recortado por limite de Discord" : ""}`;

  return chunks.map((chunk, index) => {
    const embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(chunks.length > 1 ? `Letra en espanol (${index + 1}/${chunks.length})` : "Letra en espanol")
      .setDescription(chunk)
      .setFooter({ text: footer });

    if (index === 0) {
      embed.addFields({
        name: "Cancion",
        value: trimForEmbedField(lyricsResult.artistName
          ? `${lyricsResult.artistName} - ${lyricsResult.trackName || track.title}`
          : track.title)
      });
    }

    return embed;
  });
}

function trimForEmbedField(value) {
  const text = String(value || "Audio sin titulo");
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

function splitLyricsForDiscord(text) {
  const maxTotalLength = 5200;
  const maxChunkLength = 3800;
  let remaining = String(text || "").slice(0, maxTotalLength).trim();
  const truncated = String(text || "").length > maxTotalLength;
  const chunks = [];

  while (remaining.length > maxChunkLength) {
    let splitAt = remaining.lastIndexOf("\n", maxChunkLength);

    if (splitAt < maxChunkLength * 0.6) {
      splitAt = maxChunkLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return {
    chunks: chunks.length > 0 ? chunks : ["No encontre texto para mostrar."],
    truncated
  };
}

async function replyToFailedInteraction(interaction, message) {
  if (interaction.deferred) {
    await interaction.editReply({ content: message, embeds: [], components: [] }).catch(() => {});
    return;
  }

  if (interaction.replied) {
    await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    return;
  }

  await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
}

async function handlePlay(interaction) {
  const voiceChannel = await ensureUserVoiceChannel(interaction);

  if (!voiceChannel) {
    return;
  }

  await interaction.deferReply();

  const me = await fetchBotMember(interaction.guild);
  const botChannel = me.voice?.channel;

  if (botChannel && botChannel.id !== voiceChannel.id) {
    await interaction.editReply("Ya estoy ocupado en otro canal de voz de este servidor.");
    return;
  }

  const canJoin = await ensureBotCanJoin(interaction, voiceChannel, me);

  if (!canJoin) {
    return;
  }

  const query = interaction.options.getString("query", true);
  const player = getGuildPlayer(interaction.guild);
  const connectPromise = player.connect(voiceChannel);
  const trackPromise = resolveTrack(query, interaction.user.tag);

  trackPromise.catch(() => {});
  await interaction.editReply("Entrando al canal y buscando la cancion...");
  await connectPromise;
  player.scheduleDisconnect();

  const track = await trackPromise;
  track.textChannelId = interaction.channelId;
  track.controlToken = createControlToken();
  track.lyricsUnavailable = false;
  track.syncedLyricsEnabled = false;
  track.syncedLyricsUnavailable = false;
  track.syncedLyricsLines = null;
  track.currentSubtitleLine = null;

  const startsNow = !player.currentTrack && player.queue.length === 0;
  const position = player.enqueue(track);

  const embed = createTrackEmbed(
    startsNow ? "Preparando reproduccion" : "Agregado a la cola",
    track,
    startsNow ? 0x2ecc71 : 0x1db954
  ).addFields({
    name: "Posicion",
    value: startsNow ? "Ahora" : String(position),
    inline: true
  });

  await interaction.editReply({
    content: "",
    embeds: [embed],
    components: []
  });

  void player.processQueue();
}

async function handlePreload(interaction) {
  await interaction.deferReply();

  const query = interaction.options.getString("query", true);
  const track = await resolveTrack(query, interaction.user.tag);
  await cacheTrackAudio(track);

  const embed = createTrackEmbed("Cancion guardada en cache", track, 0x95a5a6).addFields({
    name: "Estado",
    value: "Lista para reproducirse desde el disco la proxima vez."
  });

  await interaction.editReply({ embeds: [embed] });
}

async function handleSkip(interaction) {
  const player = guildPlayers.get(interaction.guild.id);

  if (!player?.currentTrack) {
    await interaction.reply("No hay ninguna cancion sonando.");
    return;
  }

  const voiceChannel = await ensureSameVoiceChannel(interaction);

  if (!voiceChannel) {
    return;
  }

  const title = player.currentTrack.title;
  player.skip();
  await interaction.reply(`Saltando **${title}**.`);
}

async function handleStop(interaction) {
  const player = guildPlayers.get(interaction.guild.id);

  if (!player) {
    await interaction.reply("No hay musica activa en este servidor.");
    return;
  }

  const voiceChannel = await ensureSameVoiceChannel(interaction);

  if (!voiceChannel) {
    return;
  }

  player.stop();
  await interaction.reply("Reproduccion detenida y cola limpiada.");
}

async function handlePause(interaction) {
  const player = guildPlayers.get(interaction.guild.id);

  if (!player?.currentTrack) {
    await interaction.reply("No hay musica reproduciendose.");
    return;
  }

  const voiceChannel = await ensureSameVoiceChannel(interaction);

  if (!voiceChannel) {
    return;
  }

  const paused = player.pause();
  if (paused) {
    await updateActiveMusicPanelControls(player);
  }

  await interaction.reply(paused ? "Musica pausada." : "No pude pausar la reproduccion.");
}

async function handleResume(interaction) {
  const player = guildPlayers.get(interaction.guild.id);

  if (!player) {
    await interaction.reply("No hay reproductor activo en este servidor.");
    return;
  }

  const voiceChannel = await ensureSameVoiceChannel(interaction);

  if (!voiceChannel) {
    return;
  }

  const resumed = player.resume();
  if (resumed) {
    await updateActiveMusicPanelControls(player);
  }

  await interaction.reply(resumed ? "Musica reanudada." : "No habia nada pausado.");
}

async function handleQueue(interaction) {
  const player = guildPlayers.get(interaction.guild.id);

  if (!player || (!player.currentTrack && player.queue.length === 0)) {
    const embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle("Cola vacia")
      .setDescription("No hay canciones pendientes en este servidor.")
      .setFooter({ text: "Usa /play para iniciar una nueva sesion de musica." });

    await interaction.reply({ embeds: [embed] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle("Cola de reproduccion")
    .setFooter({ text: "Mostrando hasta 10 canciones pendientes." })
    .setTimestamp();

  if (player.currentTrack) {
    embed.setDescription(`Ahora suena: **${trimForEmbedField(player.currentTrack.title)}**`);
    embed.addFields({
      name: "Progreso",
      value: createProgressLine(player, player.currentTrack)
    });
  }

  const queueLines = player.queue.slice(0, 10).map((track, index) => createQueueLine(track, index));

  embed.addFields(
    {
      name: "Siguientes",
      value: queueLines.length > 0 ? queueLines.join("\n") : "No hay canciones pendientes despues de la actual."
    },
    {
      name: "Resumen",
      value: `${player.queue.length} pendiente${player.queue.length === 1 ? "" : "s"} | ${createPlaybackStatus(player)}`
    }
  );

  if (player.queue.length > 10) {
    embed.addFields({
      name: "Extra",
      value: `Y ${player.queue.length - 10} mas fuera de esta vista.`
    });
  }

  await interaction.reply({ embeds: [embed] });
}

async function handleClear(interaction) {
  const player = guildPlayers.get(interaction.guild.id);

  if (!player || player.queue.length === 0) {
    await interaction.reply("La cola ya esta vacia.");
    return;
  }

  const voiceChannel = await ensureSameVoiceChannel(interaction);

  if (!voiceChannel) {
    return;
  }

  player.clearQueue();
  await interaction.reply("Cola limpiada.");
}

async function handleNowPlaying(interaction) {
  const player = guildPlayers.get(interaction.guild.id);

  if (!player?.currentTrack) {
    await interaction.reply("No hay ninguna cancion sonando ahora mismo.");
    return;
  }

  const embed = createTrackEmbed("Ahora suena", player.currentTrack, 0x3498db, { player });

  if (player.lastError) {
    embed.addFields({
      name: "Estado del reproductor",
      value: "Hubo un error reciente de audio o voz, pero el bot sigue intentando reproducir la cola."
    });
  }

  await interaction.reply({ embeds: [embed], components: createMusicControls(player) });
}

async function handleHelp(interaction) {
  const descriptions = getCommandDescriptions();

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle("Centro de control de Ultron")
    .setDescription("Comandos principales del bot de musica.")
    .addFields(
      {
        name: "Reproduccion",
        value: formatCommandGroup(descriptions, ["play", "pause", "resume", "skip", "stop"])
      },
      {
        name: "Cola y cache",
        value: formatCommandGroup(descriptions, ["queue", "clear", "nowplaying", "preload"])
      },
      {
        name: "Panel en vivo",
        value: "Cada cancion activa muestra botones, barra de progreso, estado de loop/cache y subtitulos sincronizados cuando estan disponibles."
      }
    )
    .setFooter({ text: "Los botones del panel solo funcionan desde el mismo canal de voz." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

function createQueueLine(track, index) {
  return `\`${index + 1}.\` ${trimForInline(track.title, 72)} - ${track.duration}`;
}

function trimForInline(value, maxLength) {
  const text = String(value || "Audio sin titulo").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function getCommandDescriptions() {
  return new Map(commandBuilders.map(command => {
    const data = command.toJSON();
    return [data.name, data.description];
  }));
}

function formatCommandGroup(descriptions, commandNames) {
  return commandNames
    .map(name => `\`/${name}\` - ${descriptions.get(name) || "Comando disponible"}`)
    .join("\n");
}

process.on("unhandledRejection", error => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("Uncaught exception:", error);
});

process.on("SIGINT", async () => {
  for (const player of guildPlayers.values()) {
    player.destroy();
  }

  await client.destroy();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  for (const player of guildPlayers.values()) {
    player.destroy();
  }

  await client.destroy();
  process.exit(0);
});

function withTimeout(promise, timeoutMs, fallback) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(fallback), timeoutMs);

    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value ?? true);
      },
      error => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

void loginWithRetry();

async function loginWithRetry() {
  let attempt = 0;

  while (!isDiscordReady) {
    attempt++;
    console.log(attempt === 1 ? "Conectando a Discord..." : `Reintentando conexion a Discord intento=${attempt}...`);

    try {
      await client.login(config.token);
      return;
    } catch (error) {
      console.error("No pude iniciar sesion en Discord:", error);
      await client.destroy().catch?.(() => {});
      await wait(Math.min(60_000, 5_000 * attempt));
    }
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

setTimeout(() => {
  if (!isDiscordReady) {
    console.warn("Discord aun no responde con ready. Puede ser rate-limit temporal o problema de red hacia gateway.discord.gg.");
  }
}, 30_000).unref();
