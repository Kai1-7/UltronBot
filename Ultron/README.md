# Ultron Bot

Bot de musica para Discord reconstruido desde cero con:

- cola por servidor
- slash commands
- busqueda por nombre con `/play`
- autocompletado al escribir canciones
- reproduccion usando `yt-dlp + ffmpeg`
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

Cuando una cancion empieza a sonar, el bot publica un panel nuevo con botones para pausar/reanudar, saltar, repetir en loop, detener, buscar la letra completa en espanol y activar subtitulos sincronizados. Al pasar a otra cancion, el panel anterior queda desactivado para que los botones siempre correspondan a la cancion activa. Si activas `Loop`, esa cancion vuelve a empezar cada vez que termina y la cola espera hasta que vuelvas a tocar el boton para apagarlo. Si la letra original no esta en espanol, el bot intenta traducirla automaticamente antes de mostrarla. Las letras encontradas o traducidas se guardan en cache para reutilizarlas la proxima vez. Si no encuentra letra o no puede traducirla, el boton se marca como `Sin letra ES`.

El boton `Sync ES` agrega una linea de subtitulo al panel activo y la va actualizando con el tiempo de la cancion cuando LRCLIB tiene timestamps sincronizados para esa pista.

Cuando la cola queda vacia, el bot permanece en el canal si todavia hay personas conectadas. Se sale automaticamente cuando el canal de voz se queda sin usuarios humanos, o cuando alguien usa `/stop`.

## Variables de entorno

- `TOKEN`: token del bot de Discord
- `PORT`: puerto del health server. Opcional, por defecto `10000`
- `GUILD_ID`: opcional. Si lo pones, los slash commands se registran solo en ese servidor y aparecen casi al instante
- `INACTIVITY_TIMEOUT_MS`: opcional. Intervalo para revisar inactividad cuando no hay cola, por defecto `120000`
- `LYRICS_CACHE_DIR`: opcional. Carpeta para cache persistente de letras, por defecto `cache/lyrics`

## Ejecutar local

```bash
npm install
npm start
```

Usa `.env.example` como base para tu `.env`.

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
