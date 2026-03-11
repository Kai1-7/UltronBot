require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  Collection
} = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState
} = require("@discordjs/voice");
const play = require("play-dl");
const ytSearch = require("yt-search");

const TOKEN = process.env.TOKEN;

if (!TOKEN) {
  throw new Error("Falta la variable de entorno TOKEN. En local usa .env y en Railway agregala en Variables.");
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const guildPlayers = new Collection();

const slashCommands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Reproduce una cancion o la agrega a la cola")
    .addStringOption(option =>
      option
        .setName("query")
        .setDescription("Nombre o URL de YouTube")
        .setRequired(true)
        .setAutocomplete(true)
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Salta la cancion actual"),
  new SlashCommandBuilder().setName("stop").setDescription("Detiene la musica y limpia la cola"),
  new SlashCommandBuilder().setName("pause").setDescription("Pausa la reproduccion"),
  new SlashCommandBuilder().setName("resume").setDescription("Reanuda la reproduccion"),
  new SlashCommandBuilder().setName("queue").setDescription("Muestra la cola del servidor"),
  new SlashCommandBuilder().setName("clear").setDescription("Limpia la cola pendiente"),
  new SlashCommandBuilder().setName("nowplaying").setDescription("Muestra la cancion que esta sonando")
].map(command => command.toJSON());

class GuildMusicPlayer {
  constructor(guild) {
    this.guild = guild;
    this.queue = [];
    this.currentTrack = null;
    this.connection = null;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    this.isPlaying = false;
    this.disconnectTimer = null;
    this.lastVoiceError = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.currentTrack = null;
      this.isPlaying = false;
      void this.processQueue();
    });

    this.player.on("error", error => {
      console.error(`[Audio:${this.guild.name}]`, error);
      this.lastVoiceError = error;
      this.currentTrack = null;
      this.isPlaying = false;
      void this.processQueue();
    });
  }

  enqueue(track) {
    this.queue.push(track);
    this.clearDisconnectTimer();
    return this.queue.length;
  }

  async connect(voiceChannel) {
    if (
      this.connection &&
      this.connection.joinConfig.channelId === voiceChannel.id &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      return this.connection;
    }

    if (this.connection) {
      this.connection.destroy();
    }

    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    this.installNetworkingWorkaround(this.connection);
    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch {
        this.destroy();
      }
    });

    return this.connection;
  }

  installNetworkingWorkaround(connection) {
    connection.on("stateChange", (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[Voice:${this.guild.name}] ${oldState.status} -> ${newState.status}`);
      }

      const oldNetworking = Reflect.get(oldState, "networking");
      const newNetworking = Reflect.get(newState, "networking");

      const networkStateChangeHandler = (_oldNetworkState, newNetworkState) => {
        const udp = Reflect.get(newNetworkState, "udp");
        clearInterval(udp?.keepAliveInterval);
      };

      oldNetworking?.off("stateChange", networkStateChangeHandler);
      newNetworking?.on("stateChange", networkStateChangeHandler);
    });
  }

  async processQueue() {
    if (this.isPlaying) {
      return;
    }

    if (!this.connection) {
      return;
    }

    const nextTrack = this.queue.shift();
    if (!nextTrack) {
      this.scheduleDisconnect();
      return;
    }

    this.clearDisconnectTimer();
    this.currentTrack = nextTrack;
    this.isPlaying = true;

    try {
      const ready = await this.ensureVoiceReady();
      if (!ready) {
        throw new Error("La conexion de voz no llego a Ready.");
      }

      const stream = await play.stream(nextTrack.url, {
        discordPlayerCompatibility: true,
        quality: 2
      });

      const resource = createAudioResource(stream.stream, {
        inputType: stream.type,
        inlineVolume: true
      });

      resource.volume?.setVolume(0.85);
      this.player.play(resource);
    } catch (error) {
      console.error(`[Playback:${this.guild.name}]`, error);
      this.lastVoiceError = error;
      this.currentTrack = null;
      this.isPlaying = false;
      void this.processQueue();
    }
  }

  async ensureVoiceReady() {
    if (!this.connection) {
      return false;
    }

    if (this.connection.state.status === VoiceConnectionStatus.Ready) {
      return true;
    }

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
      return true;
    } catch (error) {
      console.error(`La conexion de voz no llego a Ready para ${this.guild.name}:`, error);
      this.lastVoiceError = error;
      return false;
    }
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  skip() {
    this.player.stop(true);
  }

  stop() {
    this.queue = [];
    this.currentTrack = null;
    this.isPlaying = false;
    this.player.stop(true);
    this.destroy();
  }

  clearQueue() {
    this.queue = [];
  }

  scheduleDisconnect() {
    this.clearDisconnectTimer();
    this.disconnectTimer = setTimeout(() => {
      if (!this.currentTrack && this.queue.length === 0) {
        this.destroy();
      }
    }, 120_000);
  }

  clearDisconnectTimer() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  destroy() {
    this.clearDisconnectTimer();

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {}
      this.connection = null;
    }

    this.currentTrack = null;
    this.isPlaying = false;
    guildPlayers.delete(this.guild.id);
  }
}

client.once("clientReady", async readyClient => {
  console.log(`Bot listo como ${readyClient.user.tag}`);

  if (!(await play.validate("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))) {
    console.warn("play-dl no pudo validar YouTube correctamente al iniciar.");
  }

  await readyClient.application.commands.set(slashCommands);
  console.log("Comandos registrados correctamente.");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isAutocomplete()) {
    return;
  }

  const focused = interaction.options.getFocused().trim();
  if (focused.length < 2) {
    await interaction.respond([]);
    return;
  }

  try {
    const result = await ytSearch(focused);
    const choices = result.videos.slice(0, 5).map(video => ({
      name: trimForChoice(`${video.title} - ${formatDuration(video.timestamp)}`),
      value: video.url
    }));

    await interaction.respond(choices);
  } catch (error) {
    if (error.code === 10062 || error.rawError?.code === 10062) {
      return;
    }

    console.error("Error en autocomplete:", error);
    await interaction.respond([]).catch(() => {});
  }
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  try {
    switch (interaction.commandName) {
      case "play":
        await handlePlay(interaction);
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
      default:
        break;
    }
  } catch (error) {
    console.error(`Error ejecutando /${interaction.commandName}:`, error);

    const message = "Hubo un error ejecutando el comando.";
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

async function handlePlay(interaction) {
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel) {
    await interaction.reply("Debes estar en un canal de voz para usar /play.");
    return;
  }

  const me = interaction.guild.members.me;
  const currentChannel = me?.voice?.channel;
  if (currentChannel && currentChannel.id !== voiceChannel.id) {
    await interaction.reply("Ya estoy ocupado en otro canal de voz de este servidor.");
    return;
  }

  await interaction.deferReply();

  const query = interaction.options.getString("query", true);
  const track = await resolveTrack(query, interaction.user.tag);
  const player = getGuildPlayer(interaction.guild);

  await player.connect(voiceChannel);
  const position = player.enqueue(track);
  const ready = await player.ensureVoiceReady();

  const embed = new EmbedBuilder()
    .setColor(0x1db954)
    .setTitle("Agregado a la cola")
    .setDescription(`**${track.title}**`)
    .addFields(
      { name: "Duracion", value: track.duration, inline: true },
      { name: "Pedido por", value: track.requestedBy, inline: true },
      { name: "Posicion", value: String(position), inline: true }
    )
    .setURL(track.url);

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  if (!ready) {
    embed.addFields({
      name: "Aviso",
      value: "No pude completar la conexion de voz. El tema quedo en cola, pero revisa red, firewall o bloqueo de voz del host."
    });
  }

  await interaction.editReply({ embeds: [embed] });
  void player.processQueue();
}

async function handleSkip(interaction) {
  const player = guildPlayers.get(interaction.guild.id);
  if (!player?.currentTrack) {
    await interaction.reply("No hay ninguna cancion sonando.");
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

  player.stop();
  await interaction.reply("Reproduccion detenida y cola limpiada.");
}

async function handlePause(interaction) {
  const player = guildPlayers.get(interaction.guild.id);
  if (!player?.currentTrack) {
    await interaction.reply("No hay musica reproduciendose.");
    return;
  }

  const paused = player.pause();
  await interaction.reply(paused ? "Musica pausada." : "No pude pausar la reproduccion.");
}

async function handleResume(interaction) {
  const player = guildPlayers.get(interaction.guild.id);
  if (!player) {
    await interaction.reply("No hay reproductor activo en este servidor.");
    return;
  }

  const resumed = player.resume();
  await interaction.reply(resumed ? "Musica reanudada." : "No habia nada pausado.");
}

async function handleQueue(interaction) {
  const player = guildPlayers.get(interaction.guild.id);
  if (!player || (!player.currentTrack && player.queue.length === 0)) {
    await interaction.reply("La cola esta vacia.");
    return;
  }

  const lines = [];

  if (player.currentTrack) {
    lines.push(`Ahora suena: **${player.currentTrack.title}** (${player.currentTrack.duration})`);
  }

  player.queue.slice(0, 10).forEach((track, index) => {
    lines.push(`${index + 1}. ${track.title} (${track.duration})`);
  });

  if (player.queue.length > 10) {
    lines.push(`...y ${player.queue.length - 10} mas.`);
  }

  await interaction.reply(lines.join("\n"));
}

async function handleClear(interaction) {
  const player = guildPlayers.get(interaction.guild.id);
  if (!player || player.queue.length === 0) {
    await interaction.reply("La cola ya esta vacia.");
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

  const track = player.currentTrack;
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("Ahora suena")
    .setDescription(`**${track.title}**`)
    .addFields(
      { name: "Duracion", value: track.duration, inline: true },
      { name: "Pedido por", value: track.requestedBy, inline: true }
    )
    .setURL(track.url);

  if (track.thumbnail) {
    embed.setThumbnail(track.thumbnail);
  }

  if (player.lastVoiceError) {
    embed.addFields({
      name: "Estado de voz",
      value: "Hubo un problema reciente con la conexion de voz del host."
    });
  }

  await interaction.reply({ embeds: [embed] });
}

function getGuildPlayer(guild) {
  if (!guildPlayers.has(guild.id)) {
    guildPlayers.set(guild.id, new GuildMusicPlayer(guild));
  }

  return guildPlayers.get(guild.id);
}

async function resolveTrack(query, requestedBy) {
  if (play.yt_validate(query) === "video") {
    const videoInfo = await play.video_basic_info(query);
    const details = videoInfo.video_details;

    return {
      title: details.title,
      url: details.url,
      duration: formatDuration(details.durationRaw),
      thumbnail: details.thumbnails?.[0]?.url || null,
      requestedBy
    };
  }

  const searchResult = await ytSearch(query);
  const firstVideo = searchResult.videos?.[0];

  if (!firstVideo) {
    throw new Error("No encontre resultados para esa busqueda.");
  }

  return {
    title: firstVideo.title,
    url: firstVideo.url,
    duration: formatDuration(firstVideo.timestamp),
    thumbnail: firstVideo.thumbnail,
    requestedBy
  };
}

function formatDuration(value) {
  return value && value !== "0:00" ? value : "En vivo";
}

function trimForChoice(text) {
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

client.login(TOKEN);
