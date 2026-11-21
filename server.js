import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 7000;

/* ============================================================
   CONFIG — tukar sini ikut keperluan kau
   ============================================================ */
const CONFIG = {
  // Base URL addon ni akan di-host. Kalau local je, biar localhost.
  // Untuk guna dari Stremio di device lain (TV/phone), tukar ke IP LAN kau
  // contoh: "http://192.168.1.100:7000"
  // Auto-detect base URL: guna RENDER_EXTERNAL_URL bila deploy online,
  // atau BASE_URL env, atau fallback local.
  baseURL:
    process.env.BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    "http://localhost:7000",

  // Torrentio instance. "http://torrentio.strem.fun" adalah public mirror.
  // Torrentio kadang down — ada mirror lain, tukar kalau perlu.
  torrentio: "https://torrentio.strem.fun",

  // Tambah Debrid (Real-Debrid / AllDebrid / Premiumize) untuk stream stabil.
  // Format Torrentio: /<provider>/<apiKey>/
  // Contoh Real-Debrid: "/realdebrid/ABCDEF123456/"
  // Kosongkan kalau tak guna debrid (magnet je, guna P2P).
  debridPath: "",

  // Timeout (ms) untuk setiap source supaya satu source down tak halang yang lain
  // Render free tier cold-start lambat, jadi naikkan ke 20s
  timeout: 20000,
};

/* ============================================================
   Manifest
   ============================================================ */
const manifest = {
  id: "org.anon.multisource",
  version: "1.0.0",
  name: "Multi Source (Torrentio + TPB + ELF)",
  description: "Gabungan Torrentio, The Pirate Bay, dan ELF Media dalam satu addon.",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "kitsu", "imdb"],
  catalogs: [],
};

app.get("/manifest.json", (req, res) => {
  res.json(manifest);
});

/* ============================================================
   Helpers
   ============================================================ */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

// Parse IMDB id dari Stremio id format "tt1234567" atau "tt1234567:1:1"
function extractImdb(id) {
  const m = id.match(/^(tt\d+)/);
  return m ? m[1] : id;
}

/* ============================================================
   1) Torrentio
   ============================================================ */
async function fetchTorrentio(type, imdbId, season, episode) {
  // Torrentio path: /<debrid>/stream/<type>/<id>.json
  // Untuk series: append :<season>:<episode>
  let streamId = imdbId;
  if (type === "series") {
    streamId = `${imdbId}:${season}:${episode}`;
  }

  const url = `${CONFIG.torrentio}${CONFIG.debridPath}stream/${type}/${streamId}.json`;
  const res = await withTimeout(fetch(url, {
    headers: { "User-Agent": "Stremio" },
  }), CONFIG.timeout);

  if (!res.ok) throw new Error(`torrentio ${res.status}`);
  const data = await res.json();
  return (data.streams || []).map((s) => ({
    ...s,
    name: `[Torrentio] ${s.name}`,
    source: "torrentio",
  }));
}

/* ============================================================
   2) The Pirate Bay (TPB) — via apibay.org API
   ============================================================ */
async function fetchTPB(type, imdbId, title, season, episode) {
  // TPB cari ikut nama, bukan imdb. Guna query title.
  let query = title;
  if (type === "series") {
    query = `${title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }

  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=`;
  const res = await withTimeout(fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  }), CONFIG.timeout);

  if (!res.ok) throw new Error(`tpb ${res.status}`);
  const results = await res.json();

  // apibay return array, atau {error: ...} kalau takde
  if (!Array.isArray(results)) return [];

  return results
    .filter((r) => r && r.info_hash && r.seeders > 0)
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, 30)
    .map((r) => {
      const magnet = `magnet:?xt=urn:btih:${r.info_hash}&dn=${encodeURIComponent(r.name)}&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
      const sizeGB = (r.size / 1024 / 1024 / 1024).toFixed(2);
      return {
        name: `[TPB] ${r.name}`,
        title: `${r.name}\n👤 Seeders: ${r.seeders} | Leechers: ${r.leechers} | 💾 ${sizeGB} GB`,
        infoHash: r.info_hash,
        fileIdx: 0,
        externalUrl: magnet,
        behaviorHints: { notWebReady: true, bingeGroup: `tpb-${r.info_hash}` },
        source: "tpb",
      };
    });
}

/* ============================================================
   3) ELF Media — via elfhosted scraper
   ELF Media = scrape beberapa provider (YTS, EZTV, dll).
   Guna endpoint CinemaMeta/elf-hosted. Fallback ke YTS + EZTV API.
   ============================================================ */
async function fetchElf(type, imdbId, season, episode) {
  const streams = [];
  const addonBase = "https://elfhosted.com";

  // YTS (filem je, kualiti kecil)
  if (type === "movie") {
    try {
      const ytsUrl = `https://yts.mx/api/v2/movie_details.json?imdb_id=${imdbId}`;
      const res = await withTimeout(fetch(ytsUrl), CONFIG.timeout);
      if (res.ok) {
        const data = await res.json();
        const movie = data.data?.movie;
        if (movie && movie.torrents) {
          for (const t of movie.torrents) {
            streams.push({
              name: `[ELF/YTS] ${t.quality} (${t.type})`,
              title: `${movie.title}\n${t.quality} ${t.type}\n👤 Seeds: ${t.seeds} | Peers: ${t.peers} | 💾 ${(t.size_bytes/1024/1024/1024).toFixed(2)} GB`,
              infoHash: t.hash,
              fileIdx: 0,
              externalUrl: buildMagnet(t.hash, movie.title_long),
              behaviorHints: { notWebReady: true, bingeGroup: `yts-${t.hash}` },
              source: "elf",
            });
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  // EZTV (series)
  if (type === "series") {
    try {
      const eztvUrl = `https://eztvx.to/api/get-torrents?imdb_id=${imdbId}&limit=100`;
      const res = await withTimeout(fetch(eztvUrl), CONFIG.timeout);
      if (res.ok) {
        const data = await res.json();
        const eps = (data.torrents || []).filter((t) =>
          t.season === String(season) && t.episode === String(episode)
        );
        for (const t of eps) {
          streams.push({
            name: `[ELF/EZTV] S${t.season}E${t.episode} ${t.quality}`,
            title: `${t.title}\n👤 Seeds: ${t.seeds} | Peers: ${t.peers} | 💾 ${(t.size_bytes/1024/1024/1024).toFixed(2)} GB`,
            infoHash: t.hash,
            fileIdx: 0,
            externalUrl: t.magnet_url,
            behaviorHints: { notWebReady: true, bingeGroup: `eztv-${t.hash}` },
            source: "elf",
          });
        }
      }
    } catch (e) { /* ignore */ }
  }

  return streams;
}

function buildMagnet(hash, name) {
  const dn = encodeURIComponent(name || hash);
  return `magnet:?xt=urn:btih:${hash}&dn=${dn}&tr=udp://tracker.openbittorrent.com:80/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
}

/* ============================================================
   /stream endpoint — aggregate semua source
   ============================================================ */
app.get("/stream/:type/:id.json", async (req, res) => {
  const type = req.params.type;
  const id = req.params.id;
  const imdbId = extractImdb(id);

  // series: id format "ttXXXXX:SEASON:EPISODE"
  let season = 1, episode = 1;
  if (type === "series") {
    const parts = id.split(":");
    season = parseInt(parts[1] || "1", 10);
    episode = parseInt(parts[2] || "1", 10);
  }

  // Title dari query string (Stremio hantar ?title=... boleh guna untuk TPB)
  const title = req.query.title || "";

  const tasks = [
    fetchTorrentio(type, imdbId, season, episode).catch((e) => { console.log("[torrentio] fail:", e.message); return []; }),
    fetchTPB(type, imdbId, title, season, episode).catch((e) => { console.log("[tpb] fail:", e.message); return []; }),
    fetchElf(type, imdbId, season, episode).catch((e) => { console.log("[elf] fail:", e.message); return []; }),
  ];

  const [torrentio, tpb, elf] = await Promise.all(tasks);

  console.log(`[/stream] ${type}/${imdbId} -> torrentio:${torrentio.length} tpb:${tpb.length} elf:${elf.length}`);

  const all = [...torrentio, ...tpb, ...elf];

  // Dedup ikut infoHash/magnet (elak stream sama berulang)
  const seen = new Set();
  const unique = all.filter((s) => {
    const key = s.infoHash || s.url || s.externalUrl;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  res.json({ streams: unique });
});

/* ============================================================
   Health + root
   ============================================================ */
app.get("/", (req, res) => {
  res.type("text/html").send(`
    <h1>Multi Source Stremio Addon</h1>
    <p>Addon aktif. Tambah URL ni dalam Stremio:</p>
    <code>${CONFIG.baseURL}/manifest.json</code>
    <p>Sources: Torrentio + The Pirate Bay + ELF Media (YTS/EZTV)</p>
  `);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n  ✅ Stremio multi-source addon running`);
  console.log(`  ➜ Manifest: ${CONFIG.baseURL}/manifest.json\n`);
});
