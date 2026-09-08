/* ════════════════════════════════════════════════
   FACEBOOK — pubblicazione di un reel su una Pagina (Graph API)
   Percorso separato da Instagram: Instagram usa graph.instagram.com con il suo
   token, Facebook usa graph.facebook.com con il token della Pagina.

   Flusso ufficiale dei Reel di Pagina, tre fasi:
     1. POST {PAGE}/video_reels  upload_phase=start        → video_id + upload_url
     2. POST {upload_url}  header Authorization: OAuth …, header file_url: …
        (Meta scarica il video da solo: l'URL deve essere pubblico e permettere
         lo user agent facebookexternalhit, quindi non bloccato da robots.txt)
     3. POST {PAGE}/video_reels  upload_phase=finish&video_state=PUBLISHED&description=…
   Poi GET {video_id}?fields=status per sapere se è andata a buon fine.

   Permessi dell'app: pages_show_list, pages_read_engagement, pages_manage_posts.
   In modalità sviluppo bastano se Adriano è amministratore dell'app e della Pagina.

   Variabili (Railway):
     FB_PAGE_ID       id numerico della Pagina
     FB_PAGE_TOKEN    token della Pagina (non quello dell'utente)
     FB_API_VERSION   default v23.0
     FB_ENABLED=0     spegne la pubblicazione
   ──────────────────────────────────────────────── */
'use strict';
const env = (k, d = '') => (process.env[k] || d).trim();
const VER = () => env('FB_API_VERSION', 'v23.0');
let dynamicToken = null;
const setToken = (t) => { dynamicToken = t || null; };
const TOKEN = () => dynamicToken || env('FB_PAGE_TOKEN');
const PAGE = () => env('FB_PAGE_ID');
const log = (...a) => console.log('[FB]', ...a);

const configured = () => !!(TOKEN() && PAGE()) && env('FB_ENABLED') !== '0';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(pathname, { method = 'GET', params = {}, timeoutMs = 60000 } = {}) {
  const url = new URL(`https://graph.facebook.com/${VER()}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: TOKEN() });
  const opts = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (method === 'GET') url.search = body.toString();
  else { opts.body = body; opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; }
  const r = await fetch(url, opts);
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch (e) { throw new Error(`risposta non JSON (${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`${r.status} ${e.code || ''} ${e.error_user_title || ''} ${e.message || text.slice(0, 200)}`.replace(/\s+/g, ' ').trim());
  }
  return j;
}

/** Pagina collegata: { id, name } — serve a verificare il token */
const me = () => api(PAGE(), { params: { fields: 'id,name,followers_count' } });

/** scadenza del token: i token di Pagina derivati da un token utente lungo non scadono */
async function tokenInfo() {
  const j = await api('debug_token', { params: { input_token: TOKEN() } });
  const d = j.data || {};
  return { valid: !!d.is_valid, expiresAt: d.expires_at || 0, scopes: d.scopes || [], type: d.type || '' };
}

/**
 * Pubblica un reel sulla Pagina. → { id, permalink }
 * videoUrl deve essere raggiungibile pubblicamente da facebookexternalhit.
 */
async function publishReel({ videoUrl, description = '', onProgress = () => {} }) {
  if (!configured()) throw new Error('Facebook non configurato: mancano FB_PAGE_ID e FB_PAGE_TOKEN');
  if (!videoUrl) throw new Error('videoUrl mancante');

  log('apro la sessione di caricamento…');
  const start = await api(`${PAGE()}/video_reels`, { method: 'POST', params: { upload_phase: 'start' } });
  const videoId = start.video_id;
  const uploadUrl = start.upload_url;
  if (!videoId || !uploadUrl) throw new Error('Facebook non ha restituito video_id/upload_url');
  onProgress('sessione aperta', videoId);

  log('Facebook scarica il video…');
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `OAuth ${TOKEN()}`, file_url: videoUrl, offset: '0' },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const upText = await up.text();
  let upJson = {};
  try { upJson = JSON.parse(upText); } catch (e) {}
  if (!up.ok || upJson.error || upJson.success === false) {
    const msg = (upJson.error && (upJson.error.message || upJson.error.error_user_msg)) || upText.slice(0, 300);
    throw new Error(`caricamento rifiutato (${up.status}): ${msg}. Controlla che ${videoUrl} sia pubblico e non bloccato da robots.txt per facebookexternalhit.`);
  }
  onProgress('video caricato', videoId);

  log('pubblico…');
  await api(`${PAGE()}/video_reels`, {
    method: 'POST',
    params: { video_id: videoId, upload_phase: 'finish', video_state: 'PUBLISHED', description: String(description).slice(0, 2200) },
  });

  // l'elaborazione continua dopo il finish: aspetto che sia pubblicato davvero
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 8 * 60 * 1000) {
    await sleep(6000);
    let st;
    try { st = await api(videoId, { params: { fields: 'status,permalink_url' } }); }
    catch (e) { continue; }
    const s = st.status || {};
    const phase = `${s.video_status || ''}/${s.publishing_phase && s.publishing_phase.status || ''}`;
    if (phase !== last) { last = phase; log('stato', phase); onProgress(phase, videoId); }
    if (s.video_status === 'ready' || (s.publishing_phase && s.publishing_phase.status === 'complete')) {
      return { id: videoId, permalink: st.permalink_url || `https://www.facebook.com/reel/${videoId}` };
    }
    if (s.video_status === 'error' || (s.uploading_phase && s.uploading_phase.status === 'error')) {
      throw new Error(`Facebook: elaborazione fallita (${JSON.stringify(s).slice(0, 200)})`);
    }
  }
  // non è un errore: spesso finisce di elaborare da solo poco dopo
  return { id: videoId, permalink: `https://www.facebook.com/reel/${videoId}`, pending: true };
}

module.exports = { configured, me, tokenInfo, publishReel, setToken };
