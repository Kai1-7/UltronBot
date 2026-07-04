const { SlashCommandBuilder } = require("discord.js");

function guildOnly(builder) {
  return builder.setDMPermission(false);
}

const commands = [
  guildOnly(
    new SlashCommandBuilder()
      .setName("play")
      .setDescription("Reproduce una cancion o la agrega a la cola")
      .addStringOption(option =>
        option
          .setName("query")
          .setDescription("Nombre de la cancion o URL de YouTube")
          .setRequired(true)
          .setAutocomplete(true)
      )
  ),
  guildOnly(
    new SlashCommandBuilder()
      .setName("preload")
      .setDescription("Guarda una cancion en cache para reproducirla mas estable despues")
      .addStringOption(option =>
        option
          .setName("query")
          .setDescription("Nombre de la cancion o URL de YouTube")
          .setRequired(true)
          .setAutocomplete(true)
      )
  ),
  guildOnly(new SlashCommandBuilder().setName("skip").setDescription("Salta la cancion actual")),
  guildOnly(new SlashCommandBuilder().setName("stop").setDescription("Detiene la musica y limpia la cola")),
  guildOnly(new SlashCommandBuilder().setName("pause").setDescription("Pausa la reproduccion")),
  guildOnly(new SlashCommandBuilder().setName("resume").setDescription("Reanuda la reproduccion")),
  guildOnly(new SlashCommandBuilder().setName("queue").setDescription("Muestra la cola del servidor")),
  guildOnly(new SlashCommandBuilder().setName("clear").setDescription("Limpia la cola pendiente")),
  guildOnly(new SlashCommandBuilder().setName("nowplaying").setDescription("Muestra la cancion actual")),
  guildOnly(new SlashCommandBuilder().setName("help").setDescription("Muestra los comandos disponibles"))
];

module.exports = {
  commandBuilders: commands,
  slashCommands: commands.map(command => command.toJSON())
};
