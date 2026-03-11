# Ultron Bot

Bot de musica para Discord listo para desplegarse en Render o Railway.

## Variables de entorno

Necesitas configurar esta variable:

- `TOKEN`: token del bot de Discord.

## Ejecutar local

```bash
npm install
npm start
```

Para local, crea un archivo `.env` basado en `.env.example`.

## Deploy en Render

### Opcion 1: usando `render.yaml`

1. Sube este repositorio a GitHub.
2. En Render, elige `New +` -> `Blueprint`.
3. Selecciona este repositorio.
4. Render detectara el archivo `render.yaml` de la raiz.
5. Cuando Render te pida variables secretas, agrega `TOKEN`.
6. Despliega el servicio.

### Opcion 2: creando el Web Service manualmente

1. En Render, elige `New +` -> `Web Service`.
2. Conecta el repositorio.
3. Configura:
   - `Root Directory`: `Ultron`
   - `Build Command`: `npm install`
   - `Start Command`: `npm start`
4. En `Environment Variables`, agrega:
   - `TOKEN`: tu token real del bot
   - `NODE_VERSION`: `20.18.0`
5. Crea el servicio.

Render exige que un `Web Service` abra un puerto HTTP, por eso el bot expone `/healthz` para que el deploy quede estable.

## Deploy en Railway

1. Sube este repositorio a GitHub sin el archivo `.env`.
2. En Railway, crea un proyecto desde GitHub.
3. Al crear el servicio, usa como `Root Directory` la carpeta `Ultron`.
4. En la pestaña `Variables`, agrega `TOKEN` con el token real del bot.
5. Despliega el servicio.

Railway detecta Node.js y usara el script `npm start` de `package.json`.
