/* ════════════════════════════════════════════════
   INSTAGRAM — pubblicazione automatica di un reel (Graph API)
   Flusso ufficiale in tre passi: contenitore → attesa dell'elaborazione → pubblicazione.
   Serve un profilo Instagram professionale (Business o Creator) e un'app Meta.

   Variabili (Railway):
     IG_USER_ID        id del profilo Instagram (numerico)
     IG_ACCESS_TOKEN   token di lunga durata (60 giorni, rinnovabile)
     IG_GRAPH_HOST     graph.instagram.com (default, "Instagram login")
                       oppure graph.facebook.com ("Facebook login", profilo legato a una Pagina)
     IG_API_VERSION    default v23.0
     IG_ENABLED=0      spegne la pubblicazione automatica
   ──────────────────────────────────────────────── */
'use strict';
const env = (k, d = '') => (process.env[k] || d).trim();
const HOST = () => env('IG_GRAPH_HOST', 'graph.instagram.com');
const VER = () => env('IG_API_VERSION', 'v23.0');
const TOKEN = () => env('IG_ACCESS_TOKEN');
const USER = () => env('IG_USER_ID');
const log = (...a) => console.log('[IG]', ...a);
const warn = (...a) => console.warn('[IG]', ...a);

const configured = () => !!(TOKEN() && USER()) && env('IG_ENABLED') !== '0';

async function api(pathname, { method = 'GET', params = {}, timeoutMs = 60000 } = {}) {
  const url = new URL(`https://${HOST()}/${VER()}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: TOKEN() });
  const opts = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (method === 'GET') { url.search = body.toString(); }
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

/** profilo collegato: { id, username } — usato per verificare il token */
async function me() {
  const fields = HOST().includes('instagram') ? 'id,username,account_type' : 'id,username';
  return api(`${USER()}`, { params: { fields } });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Pubblica un reel. videoUrl deve essere raggiungibile pubblicamente (Meta lo scarica).
 * → { id, permalink }
 */
async function publishReel({ videoUrl, caption = '', coverUrl = null, shareToFeed = true, onProgress = () => {} }) {
  if (!configured()) throw new Error('Instagram non configurato: mancano IG_USER_ID e IG_ACCESS_TOKEN');
  if (!videoUrl) throw new Error('videoUrl mancante');
  const params = { media_type: 'REELS', video_url: videoUrl, caption: String(caption).slice(0, 2200), share_to_feed: shareToFeed ? 'true' : 'false' };
  if (coverUrl) params.cover_url = coverUrl;
  log('creo il contenitore…');
  const container = await api(`${USER()}/media`, { method: 'POST', params });
  const id = container.id;
  onProgress('caricato', id);
  // Instagram scarica e converte il video: di norma 30-90 s
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 8 * 60 * 1000) {
    await sleep(6000);
    const st = await api(id, { params: { fields: 'status_code,status' } });
    if (st.status_code !== last) { last = st.status_code; log('stato', st.status_code, st.status || ''); onProgress(st.status_code, id); }
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`elaborazione fallita: ${st.status || st.status_code}`);
  }
  if (last !== 'FINISHED') throw new Error('Instagram non ha finito di elaborare il video in 8 minuti');
  log('pubblico…');
  const published = await api(`${USER()}/media_publish`, { method: 'POST', params: { creation_id: id } });
  let permalink = null;
  try { permalink = (await api(published.id, { params: { fields: 'permalink' } })).permalink; } catch (e) {}
  log('pubblicato', published.id, permalink || '');
  return { id: published.id, permalink };
}

/** quante pubblicazioni restano nelle 24 h (limite Instagram: 50 post al giorno via API) */
async function quota() {
  try { const j = await api(`${USER()}/content_publishing_limit`, { params: { fields: 'config,quota_usage' } }); return (j.data && j.data[0]) || null; }
  catch (e) { return null; }
}

/** rinnova il token di lunga durata (da fare ogni 30-50 giorni) */
async function refreshToken() {
  if (HOST().includes('instagram')) {
    const url = new URL(`https://graph.instagram.com/refresh_access_token`);
    url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: TOKEN() }).toString();
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j; // { access_token, expires_in }
  }
  throw new Error('rinnovo automatico disponibile solo con graph.instagram.com');
}

module.exports = { configured, me, publishReel, quota, refreshToken, host: HOST };
