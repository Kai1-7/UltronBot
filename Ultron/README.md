# Ultron Bot

Bot de musica para Discord listo para desplegarse en Railway.

## Variables de entorno

Necesitas configurar esta variable:

- `TOKEN`: token del bot de Discord.

## Ejecutar local

```bash
npm install
npm start
```

Para local, crea un archivo `.env` basado en `.env.example`.

## Deploy en Railway

1. Sube este repositorio a GitHub sin el archivo `.env`.
2. En Railway, crea un proyecto desde GitHub.
3. Al crear el servicio, usa como `Root Directory` la carpeta `Ultron`.
4. En la pestaña `Variables`, agrega `TOKEN` con el token real del bot.
5. Despliega el servicio.

Railway detecta Node.js y usara el script `npm start` de `package.json`.
