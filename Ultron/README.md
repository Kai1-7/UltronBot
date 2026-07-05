# Ultron Bot

Bot de musica para Discord reconstruido desde cero con:

- cola por servidor
- slash commands
- busqueda por nombre con `/play`
- autocompletado al escribir canciones
- reproduccion usando `yt-dlp + ffmpeg`
- panel de musica en vivo con barra de progreso, estado y controles
- servidor HTTP `/healthz` para Render y Railway

## Comandos

- `/play query:<nombre o URL>`
- `/skip`
- `/stop`
- `/pause`
- `/resume`
- `/queue`
- `/clear`
- `/nowplaying`
- `/help`

Cuando una cancion empieza a sonar, el bot publica un panel nuevo con botones para pausar/reanudar, saltar, repetir en loop, detener, buscar la letra completa en espanol y activar subtitulos sincronizados. El panel se actualiza automaticamente con una barra de progreso, el estado de la reproduccion, la cantidad de canciones pendientes y la fuente de audio usada. Al pasar a otra cancion, el panel anterior queda desactivado para que los botones siempre correspondan a la cancion activa. Si activas `Loop`, esa cancion vuelve a empezar cada vez que termina y la cola espera hasta que vuelvas a tocar el boton para apagarlo. Si la letra original no esta en espanol, el bot intenta traducirla automaticamente antes de mostrarla. Las letras encontradas o traducidas se guardan en cache para reutilizarlas la proxima vez. Si no encuentra letra o no puede traducirla, el boton se marca como `Sin letra ES`.

El boton `Sync ES` agrega una linea de subtitulo al panel activo y la va actualizando con el tiempo de la cancion cuando LRCLIB tiene timestamps sincronizados para esa pista.

Cuando la cola queda vacia, el bot permanece en el canal si todavia hay personas conectadas. Se sale automaticamente cuando el canal de voz se queda sin usuarios humanos, o cuando alguien usa `/stop`.

## Variables de entorno

- `TOKEN`: token del bot de Discord
- `PORT`: puerto del health server. Opcional, por defecto `10000`
- `GUILD_ID`: opcional. Registra los slash commands en un solo servidor para que aparezcan casi al instante
- `GUILD_IDS`: opcional. Registra los slash commands en varios servidores separados por coma, por ejemplo `111111111111111111,847861078913187880`
- `INACTIVITY_TIMEOUT_MS`: opcional. Intervalo para revisar inactividad cuando no hay cola, por defecto `120000`
- `LYRICS_CACHE_DIR`: opcional. Carpeta para cache persistente de letras, por defecto `cache/lyrics`

## Ejecutar local

```bash
npm install
npm start
```

Usa `.env.example` como base para tu `.env`.

## Crear backup rapido

Antes de experimentar con cambios grandes, puedes crear una rama de respaldo:

```powershell
.\scripts\create-git-backup.ps1 -Push
```

## Crear link de invitacion

Desde la carpeta `Ultron`, genera un link de invitacion con permisos de administrador usando el Application ID del bot:

```powershell
.\scripts\create-discord-invite-link.ps1 -ClientId TU_APPLICATION_ID -GuildId 847861078913187880 -Admin
```

Si quieres elegir el servidor desde Discord en vez de fijarlo en el link, omite `-GuildId`.

## Deploy en Render

El archivo `render.yaml` de la raiz del repositorio ya viene preparado. Solo agrega `TOKEN`.

Puntos importantes:

- usa Node 22
- instala dependencias con `YOUTUBE_DL_SKIP_PYTHON_CHECK=true npm install`
- la raiz del servicio sigue siendo `Ultron`

## Deploy en Railway

Configura:

- Root Directory: `Ultron`
- Start Command: `npm start`

Si Railway fallara durante `npm install` por la verificacion de Python de `youtube-dl-exec`, usa como build command:

```bash
YOUTUBE_DL_SKIP_PYTHON_CHECK=true npm install
```
