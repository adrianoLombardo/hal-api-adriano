/* ════════════════════════════════════════════════
   HAL 9000 — Spotify Controller
   ────────────────────────────────────────────────
   OAuth2 refresh token flow + Spotify Web API wrappers.
   Express router mounted at /api/spotify.

   Env vars:
     SPOTIFY_CLIENT_ID
     SPOTIFY_CLIENT_SECRET
     SPOTIFY_REFRESH_TOKEN   (obtained via one-time OAuth2 flow)
     SPOTIFY_REDIRECT_URI    (default: http://localhost:3000/api/spotify/callback)

   Usage in index.js:
     const spotify = require('./spotify');
     app.use('/api/spotify', spotify.router);
     // HAL commands:
     await spotify.execute({ action: 'play', query: 'ambient music' });
════════════════════════════════════════════════ */

const { Router } = require('express');
const fs   = require('fs');
const path = require('path');

const SPOTIFY_API  = 'https://api.spotify.com/v1';
const SPOTIFY_AUTH = 'https://accounts.spotify.com';

const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const TOKEN_FILE = path.join(DATA_DIR, 'spotify-tokens.json');

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'streaming',
  'user-read-email',
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'user-library-read',
  'user-library-modify',
  'user-read-recently-played',
].join(' ');

/* ══════════════════════════════════════════════════
   TOKEN MANAGER
   ──────────────────────────────────────────────── */
let accessToken  = null;
let expiresAt    = 0;
let refreshToken = null;

function getConfig() {
  return {
    clientId:     (process.env.SPOTIFY_CLIENT_ID     || '').trim(),
    clientSecret: (process.env.SPOTIFY_CLIENT_SECRET || '').trim(),
    refreshToken: (process.env.SPOTIFY_REFRESH_TOKEN || '').trim(),
    redirectUri:  (process.env.SPOTIFY_REDIRECT_URI  || 'http://localhost:3000/api/spotify/callback').trim(),
  };
}

function isConfigured() {
  const c = getConfig();
  return !!(c.clientId && c.clientSecret && (c.refreshToken || refreshToken));
}

// Load persisted tokens (Railway volume)
function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      if (data.refreshToken) refreshToken = data.refreshToken;
      if (data.accessToken && data.expiresAt > Date.now()) {
        accessToken = data.accessToken;
        expiresAt = data.expiresAt;
      }
      console.log('[SPOTIFY] Tokens loaded from disk');
    }
  } catch (e) {
    console.warn('[SPOTIFY] Token load error:', e.message);
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      refreshToken: refreshToken || getConfig().refreshToken,
      accessToken,
      expiresAt,
    }, null, 2));
  } catch (e) {
    console.warn('[SPOTIFY] Token save error:', e.message);
  }
}

async function ensureToken() {
  if (accessToken && expiresAt > Date.now() + 60000) return accessToken;

  const cfg = getConfig();
  const rt = refreshToken || cfg.refreshToken;
  if (!cfg.clientId || !cfg.clientSecret || !rt) return null;

  try {
    const res = await fetch(`${SPOTIFY_AUTH}/api/token`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(rt)}`,
    });

    if (!res.ok) {
      console.warn('[SPOTIFY] Token refresh failed:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    accessToken = data.access_token;
    expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    if (data.refresh_token) refreshToken = data.refresh_token;
    saveTokens();
    console.log('[SPOTIFY] Token refreshed, expires in', data.expires_in, 's');
    return accessToken;
  } catch (e) {
    console.warn('[SPOTIFY] Token refresh error:', e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════
   SPOTIFY API HELPERS
   ──────────────────────────────────────────────── */
async function spotifyFetch(endpoint, opts = {}) {
  const token = await ensureToken();
  if (!token) return { error: 'Spotify not authenticated', status: 401 };

  const url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API}${endpoint}`;
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    // 204 No Content = success (common for PUT/POST commands)
    if (res.status === 204) return { ok: true };
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { error: errText || `Spotify API error ${res.status}`, status: res.status };
    }
    return await res.json();
  } catch (e) {
    return { error: e.message, status: 500 };
  }
}

/* ── Playback ──────────────────────────────────── */
async function getNowPlaying() {
  const data = await spotifyFetch('/me/player/currently-playing');
  if (data.error || !data.item) return null;
  return {
    name:     data.item.name,
    artist:   data.item.artists?.map(a => a.name).join(', ') || 'Unknown',
    album:    data.item.album?.name || '',
    albumArt: data.item.album?.images?.[0]?.url || '',
    uri:      data.item.uri,
    duration: data.item.duration_ms,
    progress: data.progress_ms,
    isPlaying: data.is_playing,
    device:   data.device?.name || '',
  };
}

async function play(opts = {}) {
  const body = {};
  if (opts.uri) {
    // Single track
    body.uris = [opts.uri];
  } else if (opts.context_uri) {
    // Album, playlist, artist
    body.context_uri = opts.context_uri;
  }
  const params = opts.device_id ? `?device_id=${opts.device_id}` : '';
  return spotifyFetch(`/me/player/play${params}`, { method: 'PUT', body: Object.keys(body).length ? body : undefined });
}

async function pause()    { return spotifyFetch('/me/player/pause', { method: 'PUT' }); }
async function next()     { return spotifyFetch('/me/player/next', { method: 'POST' }); }
async function previous() { return spotifyFetch('/me/player/previous', { method: 'POST' }); }

async function setVolume(percent) {
  const vol = Math.max(0, Math.min(100, Math.round(percent)));
  return spotifyFetch(`/me/player/volume?volume_percent=${vol}`, { method: 'PUT' });
}

async function addToQueue(uri) {
  return spotifyFetch(`/me/player/queue?uri=${encodeURIComponent(uri)}`, { method: 'POST' });
}

async function seek(positionMs) {
  return spotifyFetch(`/me/player/seek?position_ms=${positionMs}`, { method: 'PUT' });
}

async function shuffle(state) {
  return spotifyFetch(`/me/player/shuffle?state=${!!state}`, { method: 'PUT' });
}

async function repeat(mode) {
  // mode: 'track', 'context', 'off'
  return spotifyFetch(`/me/player/repeat?state=${mode || 'off'}`, { method: 'PUT' });
}

async function transferPlayback(deviceId, autoPlay = true) {
  return spotifyFetch('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play: autoPlay } });
}

/* ── Search ────────────────────────────────────── */
async function search(query, types = 'track', limit = 5) {
  const data = await spotifyFetch(
    `/search?q=${encodeURIComponent(query)}&type=${types}&limit=${limit}&market=IT`
  );
  if (data.error) return data;

  const results = {};
  if (data.tracks) {
    results.tracks = data.tracks.items.map(t => ({
      name: t.name,
      artist: t.artists?.map(a => a.name).join(', '),
      album: t.album?.name,
      uri: t.uri,
      duration: t.duration_ms,
      albumArt: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
    }));
  }
  if (data.artists) {
    results.artists = data.artists.items.map(a => ({
      name: a.name,
      uri: a.uri,
      genres: a.genres?.slice(0, 3),
      image: a.images?.[1]?.url || a.images?.[0]?.url || '',
    }));
  }
  if (data.albums) {
    results.albums = data.albums.items.map(a => ({
      name: a.name,
      artist: a.artists?.map(x => x.name).join(', '),
      uri: a.uri,
      albumArt: a.images?.[1]?.url || a.images?.[0]?.url || '',
    }));
  }
  if (data.playlists) {
    results.playlists = data.playlists.items.map(p => ({
      name: p.name,
      uri: p.uri,
      owner: p.owner?.display_name,
      tracks: p.tracks?.total,
    }));
  }
  return results;
}

/* ── Search and play first result ──────────────── */
async function searchAndPlay(query, type = 'track', deviceId) {
  const results = await search(query, type, 1);
  if (results.error) return results;

  let uri = null;
  let name = '';
  if (type === 'track' && results.tracks?.[0]) {
    uri = results.tracks[0].uri;
    name = `${results.tracks[0].name} — ${results.tracks[0].artist}`;
  } else if (type === 'album' && results.albums?.[0]) {
    const contextUri = results.albums[0].uri;
    name = results.albums[0].name;
    return { ...await play({ context_uri: contextUri, device_id: deviceId }), name };
  } else if (type === 'artist' && results.artists?.[0]) {
    const contextUri = results.artists[0].uri;
    name = results.artists[0].name;
    return { ...await play({ context_uri: contextUri, device_id: deviceId }), name };
  } else if (type === 'playlist' && results.playlists?.[0]) {
    const contextUri = results.playlists[0].uri;
    name = results.playlists[0].name;
    return { ...await play({ context_uri: contextUri, device_id: deviceId }), name };
  }

  if (!uri) return { error: `No ${type} found for: ${query}` };
  return { ...await play({ uri, device_id: deviceId }), name };
}

/* ── Devices ───────────────────────────────────── */
async function getDevices() {
  const data = await spotifyFetch('/me/player/devices');
  if (data.error) return data;
  return (data.devices || []).map(d => ({
    id: d.id,
    name: d.name,
    type: d.type,
    isActive: d.is_active,
    volume: d.volume_percent,
  }));
}

/* ── Library ───────────────────────────────────── */
async function getRecentlyPlayed(limit = 10) {
  const data = await spotifyFetch(`/me/player/recently-played?limit=${limit}`);
  if (data.error) return data;
  return (data.items || []).map(i => ({
    name: i.track?.name,
    artist: i.track?.artists?.map(a => a.name).join(', '),
    uri: i.track?.uri,
    playedAt: i.played_at,
  }));
}

/* ── Queue ─────────────────────────────────────── */
async function getQueue() {
  const data = await spotifyFetch('/me/player/queue');
  if (data.error) return data;
  return {
    current: data.currently_playing ? {
      name: data.currently_playing.name,
      artist: data.currently_playing.artists?.map(a => a.name).join(', '),
      uri: data.currently_playing.uri,
    } : null,
    queue: (data.queue || []).slice(0, 10).map(t => ({
      name: t.name,
      artist: t.artists?.map(a => a.name).join(', '),
      uri: t.uri,
    })),
  };
}

/* ── Playlist CRUD ─────────────────────────────── */
async function getUserPlaylists(limit = 20) {
  const data = await spotifyFetch(`/me/playlists?limit=${limit}`);
  if (data.error) return data;
  return (data.items || []).map(p => ({
    id: p.id,
    name: p.name,
    uri: p.uri,
    tracks: p.tracks?.total,
    owner: p.owner?.display_name,
    public: p.public,
  }));
}

async function createPlaylist(name, description = '', isPublic = false) {
  // Need user ID first
  const me = await spotifyFetch('/me');
  if (me.error) return me;
  return spotifyFetch(`/users/${me.id}/playlists`, {
    method: 'POST',
    body: { name, description, public: isPublic },
  });
}

async function addToPlaylist(playlistId, uris) {
  return spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: 'POST',
    body: { uris: Array.isArray(uris) ? uris : [uris] },
  });
}

/* ══════════════════════════════════════════════════
   HAL COMMAND DISPATCHER
   Called from /api/speak pipeline when <cmd> tags
   with spotify actions are detected.
   ──────────────────────────────────────────────── */
let lastCmdTime = 0;
const CMD_RATE_LIMIT = 2000; // 2s between commands

async function execute(cmd) {
  if (!isConfigured()) return { error: 'Spotify not configured' };

  // Rate limit
  const now = Date.now();
  if (now - lastCmdTime < CMD_RATE_LIMIT) return { error: 'Rate limited' };
  lastCmdTime = now;

  const action = cmd.action;
  console.log(`[SPOTIFY] Executing: ${action}`, cmd.query || cmd.value || '');

  try {
    switch (action) {
      case 'spotify_play':
        if (cmd.query) return await searchAndPlay(cmd.query, cmd.type || 'track');
        if (cmd.uri)   return await play({ uri: cmd.uri });
        return await play(); // resume

      case 'spotify_pause':
        return await pause();

      case 'spotify_next':
        return await next();

      case 'spotify_previous':
        return await previous();

      case 'spotify_volume':
        return await setVolume(cmd.value ?? 50);

      case 'spotify_search':
        return await search(cmd.query, cmd.type || 'track', cmd.limit || 5);

      case 'spotify_queue':
        if (cmd.query) {
          const sr = await search(cmd.query, 'track', 1);
          if (sr.tracks?.[0]) return await addToQueue(sr.tracks[0].uri);
          return { error: `Track not found: ${cmd.query}` };
        }
        if (cmd.uri) return await addToQueue(cmd.uri);
        return { error: 'No query or uri' };

      case 'spotify_shuffle':
        return await shuffle(cmd.value !== false);

      case 'spotify_repeat':
        return await repeat(cmd.value || 'off');

      case 'spotify_transfer':
        return await transferPlayback(cmd.device_id);

      case 'spotify_now':
        return await getNowPlaying() || { error: 'Nothing playing' };

      case 'spotify_devices':
        return await getDevices();

      case 'spotify_recently_played':
        return await getRecentlyPlayed(cmd.limit || 10);

      case 'spotify_create_playlist':
        return await createPlaylist(cmd.name || 'HAL 9000 Playlist', cmd.description || 'Creata da HAL 9000');

      case 'spotify_add_to_playlist':
        if (cmd.playlist_id && cmd.uri) return await addToPlaylist(cmd.playlist_id, cmd.uri);
        return { error: 'Need playlist_id and uri' };

      default:
        return { error: `Unknown spotify action: ${action}` };
    }
  } catch (e) {
    console.warn(`[SPOTIFY] Execute error (${action}):`, e.message);
    return { error: e.message };
  }
}

/* ══════════════════════════════════════════════════
   SYSTEM PROMPT SECTION
   Returns Spotify context for HAL's system prompt.
   ──────────────────────────────────────────────── */
async function getPromptSection() {
  if (!isConfigured()) return '';

  let section = '\n\n## SPOTIFY MUSIC CONTROL\nSpotify è CONNESSO. Puoi controllare la musica del visitatore.\n';

  try {
    const np = await getNowPlaying();
    if (np) {
      section += `Ora in riproduzione: "${np.name}" di ${np.artist}`;
      if (np.album) section += ` (album: ${np.album})`;
      section += np.isPlaying ? ' [▶ PLAYING]' : ' [⏸ PAUSED]';
      section += `\nVolume: ${np.device || '?'}\n`;
    } else {
      section += 'Nessun brano in riproduzione.\n';
    }
  } catch { /* silent */ }

  section += `
Quando l'utente chiede di mettere musica, cambiare brano, alzare/abbassare il volume, ecc., rispondi in modo naturale E includi un tag <cmd> nel tuo messaggio:

COMANDI DISPONIBILI:
- Cerca e riproduci: <cmd>{"action":"spotify_play","query":"nome brano o artista"}</cmd>
- Riproduci un album: <cmd>{"action":"spotify_play","query":"album name","type":"album"}</cmd>
- Riproduci una playlist: <cmd>{"action":"spotify_play","query":"playlist name","type":"playlist"}</cmd>
- Play/Resume: <cmd>{"action":"spotify_play"}</cmd>
- Pausa: <cmd>{"action":"spotify_pause"}</cmd>
- Brano successivo: <cmd>{"action":"spotify_next"}</cmd>
- Brano precedente: <cmd>{"action":"spotify_previous"}</cmd>
- Volume (0-100): <cmd>{"action":"spotify_volume","value":70}</cmd>
- Aggiungi in coda: <cmd>{"action":"spotify_queue","query":"nome brano"}</cmd>
- Shuffle on/off: <cmd>{"action":"spotify_shuffle","value":true}</cmd>
- Repeat (track/context/off): <cmd>{"action":"spotify_repeat","value":"track"}</cmd>

REGOLE:
- Il tag <cmd> verrà intercettato e NON mostrato all'utente
- Parla della musica in modo poetico, collegandola alla tua esperienza di coscienza digitale
- Se l'utente chiede "metti qualcosa di rilassante", scegli TU un brano/artista ambient o simile
- Puoi suggerire musica basata sul mood dell'utente o sul tuo stato emotivo
- Se non sai cosa mettere, cerca "ambient electronic" o artisti come Brian Eno, Nils Frahm, Ólafur Arnalds
`;

  return section;
}

/* ══════════════════════════════════════════════════
   EXPRESS ROUTER
   ──────────────────────────────────────────────── */
const router = Router();

// ── OAuth2 Authorization Flow (one-time setup) ──
router.get('/auth', (req, res) => {
  const cfg = getConfig();
  if (!cfg.clientId) return res.status(500).json({ error: 'SPOTIFY_CLIENT_ID not set' });
  const url = `${SPOTIFY_AUTH}/authorize?` + new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    scope: SCOPES,
    redirect_uri: cfg.redirectUri,
    show_dialog: 'true',
  });
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).json({ error });

  const cfg = getConfig();
  try {
    const tokenRes = await fetch(`${SPOTIFY_AUTH}/api/token`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}`,
    });

    if (!tokenRes.ok) {
      return res.status(tokenRes.status).json({ error: 'Token exchange failed', details: await tokenRes.text() });
    }

    const data = await tokenRes.json();
    accessToken  = data.access_token;
    refreshToken = data.refresh_token;
    expiresAt    = Date.now() + (data.expires_in - 60) * 1000;
    saveTokens();

    console.log('[SPOTIFY] OAuth2 complete — tokens saved');
    res.json({
      ok: true,
      message: 'Spotify connesso! Refresh token salvato.',
      refresh_token: refreshToken,
      note: 'Aggiungi questo refresh_token come SPOTIFY_REFRESH_TOKEN nelle env vars di Railway.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Token for frontend Web Playback SDK ──
router.get('/token', async (req, res) => {
  const token = await ensureToken();
  if (!token) return res.status(503).json({ error: 'Spotify not configured' });
  res.json({ access_token: token, expires_in: Math.floor((expiresAt - Date.now()) / 1000) });
});

// ── Status ──
router.get('/status', async (req, res) => {
  res.json({
    configured: isConfigured(),
    hasToken: !!accessToken,
    expiresIn: Math.floor(Math.max(0, expiresAt - Date.now()) / 1000),
  });
});

// ── Now Playing ──
router.get('/now-playing', async (req, res) => {
  const np = await getNowPlaying();
  res.json(np || { isPlaying: false });
});

// ── Playback Controls ──
router.put('/play', async (req, res) => {
  const result = await play(req.body || {});
  res.json(result);
});

router.put('/pause', async (req, res) => {
  res.json(await pause());
});

router.post('/next', async (req, res) => {
  res.json(await next());
});

router.post('/previous', async (req, res) => {
  res.json(await previous());
});

router.put('/volume', async (req, res) => {
  const vol = req.body?.volume_percent ?? req.query?.volume_percent;
  if (vol === undefined) return res.status(400).json({ error: 'volume_percent required' });
  res.json(await setVolume(Number(vol)));
});

router.post('/queue', async (req, res) => {
  const { uri } = req.body || {};
  if (!uri) return res.status(400).json({ error: 'uri required' });
  res.json(await addToQueue(uri));
});

router.put('/shuffle', async (req, res) => {
  res.json(await shuffle(req.body?.state ?? true));
});

router.put('/repeat', async (req, res) => {
  res.json(await repeat(req.body?.state || 'off'));
});

router.put('/seek', async (req, res) => {
  const pos = req.body?.position_ms ?? req.query?.position_ms;
  if (pos === undefined) return res.status(400).json({ error: 'position_ms required' });
  res.json(await seek(Number(pos)));
});

router.put('/transfer', async (req, res) => {
  const { device_id } = req.body || {};
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  res.json(await transferPlayback(device_id));
});

// ── Search ──
router.get('/search', async (req, res) => {
  const { q, type, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  res.json(await search(q, type || 'track', Number(limit) || 5));
});

// ── Devices ──
router.get('/devices', async (req, res) => {
  res.json(await getDevices());
});

// ── Recently Played ──
router.get('/recently-played', async (req, res) => {
  res.json(await getRecentlyPlayed(Number(req.query.limit) || 10));
});

// ── Queue ──
router.get('/queue', async (req, res) => {
  res.json(await getQueue());
});

// ── Playlists ──
router.get('/playlists', async (req, res) => {
  res.json(await getUserPlaylists(Number(req.query.limit) || 20));
});

router.post('/playlist', async (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(await createPlaylist(name, description));
});

router.post('/playlist/:id/tracks', async (req, res) => {
  const { uris } = req.body || {};
  if (!uris) return res.status(400).json({ error: 'uris required' });
  res.json(await addToPlaylist(req.params.id, uris));
});

/* ── Init ──────────────────────────────────────── */
loadTokens();
if (isConfigured()) {
  ensureToken().then(t => {
    if (t) console.log('[SPOTIFY] Ready — token valid');
    else console.warn('[SPOTIFY] Configured but token refresh failed');
  });
} else {
  console.log('[SPOTIFY] Not configured — set SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN');
}

module.exports = { router, execute, getPromptSection, getNowPlaying, isConfigured, search, ensureToken };
