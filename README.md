# Stremio Multi-Source Addon

Gabungan **Torrentio + The Pirate Bay + ELF Media (YTS/EZTV)** dalam satu addon Stremio.

## Deploy (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Klik button atas → login → Apply → tunggu deploy → guna URL:
```
https://<nama-service>.onrender.com/manifest.json
```

## Run local

```powershell
npm install
npm start
```

Manifest: `http://localhost:7000/manifest.json`

## Sources

- **Torrentio** — `https://torrentio.strem.fun`
- **The Pirate Bay** — via apibay.org
- **ELF Media** — YTS (filem) + EZTV (series)

## Optional: Debrid

Dalam `server.js`, set `debridPath` ke `/realdebrid/API_KEY/` untuk stream stabil.
