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
     FB_PAGE_TOKEN    token della Pagina. Se manca si usa FB_USER_TOKEN.
     FB_USER_TOKEN    token dell'utente con pages_show_list + pages_manage_posts:
                      il server ricava da solo il token della Pagina con
                      GET /{FB_PAGE_ID}?fields=access_token e lo tiene in cache un'ora.
                      Comodo perché è quello che si copia con un clic dall'Esploratore
                      per la API Graph, e un token utente di lunga durata (60 giorni)
                      genera token di Pagina sempre validi.
                      NOTA: con «Facebook Login for Business» e gli ambiti granulari
                      /me/accounts risponde {"data":[]} anche quando la Pagina è
                      autorizzata (verificato il 2026-09-09), perché il permesso è
                      concesso sulla singola Pagina e non sull'elenco: per questo si
                      legge la Pagina per id, e /me/accounts resta solo come ripiego.
     FB_API_VERSION   default v23.0
     FB_ENABLED=0     spegne la pubblicazione
   ──────────────────────────────────────────────── */
'use strict';
const env = (k, d = '') => (process.env[k] || d).trim();
const VER = () => env('FB_API_VERSION', 'v23.0');
let dynamicToken = null;                    // token di Pagina salvato nello stato
let derived = { token: null, at: 0 };       // token di Pagina ricavato da FB_USER_TOKEN
const setToken = (t) => { dynamicToken = t || null; };
const PAGE = () => env('FB_PAGE_ID');
const log = (...a) => console.log('[FB]', ...a);
const warn = (...a) => console.warn('[FB]', ...a);

const configured = () => !!(PAGE() && (dynamicToken || env('FB_PAGE_TOKEN') || env('FB_USER_TOKEN'))) && env('FB_ENABLED') !== '0';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** token della Pagina: esplicito, salvato, oppure ricavato dal token utente */
async function TOKEN({ fresh = false } = {}) {
  const explicit = dynamicToken || env('FB_PAGE_TOKEN');
  if (explicit) return explicit;
  const user = env('FB_USER_TOKEN');
  if (!user) throw new Error('Facebook non configurato: manca FB_PAGE_TOKEN o FB_USER_TOKEN');
  if (!fresh && derived.token && Date.now() - derived.at < 3600 * 1000) return derived.token;

  const ask = async (pathname, params) => {
    const url = new URL(`https://graph.facebook.com/${VER()}/${pathname}`);
    url.search = new URLSearchParams({ ...params, access_token: user }).toString();
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    return r.json().catch(() => ({}));
  };

  // 1) la Pagina letta per id: funziona anche con gli ambiti granulari
  const direct = await ask(PAGE(), { fields: 'id,name,access_token' });
  if (direct && direct.access_token) {
    derived = { token: direct.access_token, at: Date.now() };
    log(`token della Pagina «${direct.name || PAGE()}» ricavato dal token utente`);
    return derived.token;
  }
  const firstError = direct && direct.error;

  // 2) ripiego: l'elenco delle Pagine gestite (app con login classico)
  const list = await ask('me/accounts', { fields: 'id,name,access_token', limit: '100' });
  const page = (list.data || []).find(p => String(p.id) === PAGE());
  if (page && page.access_token) {
    derived = { token: page.access_token, at: Date.now() };
    log(`token della Pagina «${page.name}» ricavato da /me/accounts`);
    return derived.token;
  }

  if (firstError) throw new Error(`token utente non valido o senza accesso alla Pagina ${PAGE()}: ${firstError.message || firstError.code}`);
  if (list.error) throw new Error(`token utente non valido: ${list.error.message || list.error.code}`);
  throw new Error(`la Pagina ${PAGE()} non ha restituito un token: controlla che il token utente abbia pages_manage_posts su quella Pagina (/me/accounts ha elencato: ${(list.data || []).map(p => p.id).join(', ') || 'nessuna'})`);
}

async function api(pathname, { method = 'GET', params = {}, timeoutMs = 60000 } = {}) {
  const url = new URL(`https://graph.facebook.com/${VER()}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: await TOKEN() });
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
  const j = await api('debug_token', { params: { input_token: await TOKEN() } });
  const d = j.data || {};
  return { valid: !!d.is_valid, expiresAt: d.expires_at || 0, scopes: d.scopes || [], type: d.type || '' };
}

/**
 * Pubblica un reel sulla Pagina. → { id, permalink }
 * videoUrl deve essere raggiungibile pubblicamente da facebookexternalhit.
 */
async function publishReel({ videoUrl, description = '', onProgress = () => {} }) {
  if (!configured()) throw new Error('Facebook non configurato: manca FB_PAGE_ID e uno tra FB_PAGE_TOKEN e FB_USER_TOKEN');
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
    headers: { Authorization: `OAuth ${await TOKEN()}`, file_url: videoUrl, offset: '0' },
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

/** quale via si sta usando: utile in /social */
const mode = () => (dynamicToken || env('FB_PAGE_TOKEN')) ? 'token di Pagina' : 'token utente';

module.exports = { configured, me, tokenInfo, publishReel, setToken, mode };
