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
let dynamicToken = null;   // token rinnovato, salvato nello stato: vince su IG_ACCESS_TOKEN finché è vivo
                           // (se Meta lo rifiuta si torna alla variabile d'ambiente, vedi scartaTokenSalvato)
let onTokenDrop = null;    // avvisa chi persiste il token salvato che va buttato via
const setToken = (t) => { dynamicToken = t || null; };
/** chi ci usa può farsi avvisare quando il token salvato viene scartato, per non riproporlo al riavvio */
const setOnTokenDrop = (fn) => { onTokenDrop = typeof fn === 'function' ? fn : null; };
const TOKEN = () => dynamicToken || env('IG_ACCESS_TOKEN');
const USER = () => env('IG_USER_ID');
const log = (...a) => console.log('[IG]', ...a);
const warn = (...a) => console.warn('[IG]', ...a);

const configured = () => !!(TOKEN() && USER()) && env('IG_ENABLED') !== '0';

/** Meta segnala un token morto con code 190 (o 102) e i sottocodici 458-467 */
function tokenMorto(status, e = {}) {
  const sub = Number(e.error_subcode);
  return status === 401 || [190, 102].includes(Number(e.code)) || (sub >= 458 && sub <= 467);
}

/** Il token salvato nello stato non deve poter bloccare per sempre: se in IG_ACCESS_TOKEN
    ce n'è uno diverso (Adriano ne ha incollato uno nuovo su Railway) si riparte da quello. */
function scartaTokenSalvato(motivo) {
  const daEnv = env('IG_ACCESS_TOKEN');
  if (!dynamicToken || !daEnv || daEnv === dynamicToken) return false;
  warn(`il token salvato non è più valido (${motivo}): riparto da IG_ACCESS_TOKEN`);
  dynamicToken = null;
  if (onTokenDrop) { try { onTokenDrop(); } catch (e) { warn('onTokenDrop:', e.message); } }
  return true;
}

async function chiamata(pathname, { method = 'GET', params = {}, timeoutMs = 60000 } = {}) {
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
    warn('errore API', pathname, text.slice(0, 500));   // mai loggare `url`: in GET contiene access_token
    const sub = e.error_subcode ? `#${e.error_subcode}` : '';
    const det = [e.error_user_title, e.error_user_msg, e.message].filter(Boolean).join(' — ') || text.slice(0, 200);
    const err = new Error(`${r.status} ${e.code || ''} ${sub} ${det}`.replace(/\s+/g, ' ').trim());
    err.tokenMorto = tokenMorto(r.status, e);
    throw err;
  }
  return j;
}

async function api(pathname, opts = {}) {
  try { return await chiamata(pathname, opts); }
  catch (e) {
    if (e.tokenMorto && scartaTokenSalvato(e.message)) return chiamata(pathname, opts);
    throw e;
  }
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
const clean = (u) => String(u || '').trim().replace(/^@+/, '');
async function publishReel({ videoUrl, caption = '', coverUrl = null, shareToFeed = true, userTags = [], collaborators = [], locationId = null, onProgress = () => {} }) {
  if (!configured()) throw new Error('Instagram non configurato: mancano IG_USER_ID e IG_ACCESS_TOKEN');
  if (!videoUrl) throw new Error('videoUrl mancante');
  const cap = String(caption);
  // il tetto di 2200 è quello vero di Instagram: qui non si può che tagliare, ma almeno si vede
  if (cap.length > 2200) warn(`didascalia di ${cap.length} caratteri: Instagram ne accetta 2200, la coda (hashtag compresi) viene tagliata`);
  const params = { media_type: 'REELS', video_url: videoUrl, caption: cap.slice(0, 2200), share_to_feed: shareToFeed ? 'true' : 'false' };
  if (coverUrl) params.cover_url = coverUrl;
  // persone taggate nel reel: solo il nome utente (niente coordinate, che valgono per le foto)
  const tags = (userTags || []).map(clean).filter(Boolean).slice(0, 20);
  if (tags.length) params.user_tags = JSON.stringify(tags.map(username => ({ username })));
  // collaboratori: max 3, devono accettare l'invito dall'app Instagram
  const collab = (collaborators || []).map(clean).filter(Boolean).slice(0, 3);
  if (collab.length) params.collaborators = JSON.stringify(collab);
  if (locationId) params.location_id = String(locationId);
  log('creo il contenitore…');
  const container = await api(`${USER()}/media`, { method: 'POST', params });
  const id = container.id;
  onProgress('caricato', id);
  // Instagram scarica e converte il video: di norma 30-90 s
  const started = Date.now();
  let last = '';
  let errori = 0;   // errori passeggeri della Graph API: non buttano via un caricamento già fatto
  while (Date.now() - started < 8 * 60 * 1000) {
    await sleep(6000);
    let st;
    try { st = await api(id, { params: { fields: 'status_code,status' } }); errori = 0; }
    catch (e) { if (++errori >= 5) throw e; warn('lettura dello stato fallita, riprovo:', e.message); continue; }
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
  if (!HOST().includes('instagram')) throw new Error('rinnovo automatico disponibile solo con graph.instagram.com');
  const chiedi = async () => {
    const url = new URL(`https://graph.instagram.com/refresh_access_token`);
    url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: TOKEN() }).toString();
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const j = await r.json().catch(() => ({}));
    if (j.error) {
      const err = new Error(j.error.message || j.error.code || `rinnovo fallito (${r.status})`);
      err.tokenMorto = tokenMorto(r.status, j.error);
      throw err;
    }
    return j; // { access_token, expires_in }
  };
  // se il token salvato è morto si riprova con quello di IG_ACCESS_TOKEN, altrimenti non se ne esce più
  try { return await chiedi(); }
  catch (e) { if (e.tokenMorto && scartaTokenSalvato(e.message)) return chiedi(); throw e; }
}

module.exports = { configured, me, publishReel, quota, refreshToken, setToken, setOnTokenDrop, host: HOST };
