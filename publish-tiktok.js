/* ════════════════════════════════════════════════
   TIKTOK — invio del video dal server (Content Posting API v2)
   Due modalità:
     bozza  (scope video.upload)  → il video arriva nelle bozze/notifiche di TikTok,
            Adriano apre l'app e pubblica con un tocco. NESSUN audit dell'app richiesto.
     diretta (scope video.publish) → pubblicazione immediata. Richiede che TikTok
            approvi l'app (audit) e che il dominio del video sia verificato.
   Il video viene caricato dal server (FILE_UPLOAD), così non serve verificare il dominio.

   Variabili (Railway):
     TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
     TIKTOK_REFRESH_TOKEN   facoltativo: se manca, il refresh token si ottiene una
                            volta sola con /tiktok sul bot (autorizzazione OAuth) e
                            viene salvato nello stato del modulo social.
     TIKTOK_REDIRECT_URI    default <PUBLIC_URL>/api/tiktok/callback
     TIKTOK_DIRECT=1   pubblica direttamente invece di mandare in bozza (solo se l'app è auditata)
     TIKTOK_PRIVACY    PUBLIC_TO_EVERYONE (default) | MUTUAL_FOLLOW_FRIENDS | SELF_ONLY
     TIKTOK_ENABLED=0  spegne l'invio
   ──────────────────────────────────────────────── */
'use strict';
const env = (k, d = '') => (process.env[k] || d).trim();
const log = (...a) => console.log('[TIKTOK]', ...a);
const warn = (...a) => console.warn('[TIKTOK]', ...a);
let saved = null;                       // refresh token ottenuto con l'OAuth e salvato nello stato
let onRotate = null;                    // chi persiste il refresh token quando TikTok lo cambia
const setRefresh = (t) => { saved = t || null; cached = { token: null, at: 0, refresh: null }; };
/** TikTok RUOTA il refresh token a ogni rinnovo: chi ci usa deve salvarlo, altrimenti
    al riavvio si riparte da uno ormai invalido e serve rifare l'autorizzazione. */
const setOnRotate = (fn) => { onRotate = typeof fn === 'function' ? fn : null; };
const REFRESH = () => saved || env('TIKTOK_REFRESH_TOKEN');
/** l'app c'è: si può avviare l'autorizzazione */
const linkable = () => !!(env('TIKTOK_CLIENT_KEY') && env('TIKTOK_CLIENT_SECRET')) && env('TIKTOK_ENABLED') !== '0';
/** l'app c'è e l'account è collegato: si può caricare */
const configured = () => linkable() && !!REFRESH();
const direct = () => env('TIKTOK_DIRECT') === '1';
const redirectUri = () => env('TIKTOK_REDIRECT_URI') || `${env('PUBLIC_URL', 'https://web-production-09adc.up.railway.app').replace(/\/$/, '')}/api/tiktok/callback`;

/** link da aprire una volta sola per autorizzare l'account TikTok */
function authUrl(state) {
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
  u.search = new URLSearchParams({
    client_key: env('TIKTOK_CLIENT_KEY'),
    scope: env('TIKTOK_SCOPES', direct() ? 'user.info.basic,video.publish' : 'user.info.basic,video.upload'),
    response_type: 'code',
    redirect_uri: redirectUri(),
    state: String(state || ''),
  }).toString();
  return u.toString();
}

/** scambia il codice dell'autorizzazione con i token → { refresh_token, open_id, … } */
async function exchangeCode(code) {
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'),
      code, grant_type: 'authorization_code', redirect_uri: redirectUri(),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${j.error || r.status}: ${j.error_description || 'scambio del codice fallito'}`);
  if (!j.refresh_token) throw new Error('TikTok non ha restituito il refresh token');
  return j;
}

let cached = { token: null, at: 0, refresh: null };

async function accessToken() {
  if (cached.token && Date.now() - cached.at < 60 * 60 * 1000) return cached.token;
  const usato = cached.refresh || REFRESH();
  if (!usato) throw new Error('TikTok: nessun refresh token. Manda /tiktok al bot.');
  const r = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'),
      grant_type: 'refresh_token', refresh_token: usato,
    }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`token: ${j.error_description || j.error || r.status}`);
  const nuovo = j.refresh_token || cached.refresh;
  const ruotato = !!(j.refresh_token && j.refresh_token !== usato);
  cached = { token: j.access_token, at: Date.now(), refresh: nuovo };
  if (ruotato) {
    saved = j.refresh_token;
    log('refresh token ruotato da TikTok, lo salvo');
    if (onRotate) { try { onRotate(j.refresh_token); } catch (e) { warn('salvataggio refresh token:', e.message); } }
  }
  return cached.token;
}

async function post(url, body, token) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  const err = j.error && j.error.code && j.error.code !== 'ok' ? j.error : null;
  if (!r.ok || err) throw new Error(`${r.status} ${(err && (err.message || err.code)) || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/** profilo collegato: { open_id, display_name } — verifica che il refresh token sia valido */
async function me() {
  const token = await accessToken();
  // solo campi coperti da user.info.basic: `username` vuole user.info.profile, che non chiediamo
  // mai in authUrl, e TikTok rifiuterebbe l'intera chiamata con scope_not_authorized.
  const r = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  if (j.error && j.error.code !== 'ok') throw new Error(j.error.message || j.error.code);
  return (j.data && j.data.user) || {};
}

/** limiti dell'account per la pubblicazione diretta (titolo, privacy consentite, commenti…) */
async function creatorInfo() {
  const token = await accessToken();
  return post('https://open.tiktokapis.com/v2/post/publish/creator_info/query/', {}, token);
}

/**
 * Manda un video a TikTok. Con TIKTOK_DIRECT=1 lo pubblica, altrimenti lo lascia in bozza.
 * → { publish_id, mode }
 */
async function sendVideo({ videoUrl, title = '', onProgress = () => {} }) {
  if (!configured()) throw new Error(linkable()
    ? 'TikTok: account non ancora collegato. Manda /tiktok al bot e apri il link di autorizzazione.'
    : 'TikTok non configurato: mancano TIKTOK_CLIENT_KEY e TIKTOK_CLIENT_SECRET');
  const token = await accessToken();
  onProgress('scarico il video');
  const res = await fetch(videoUrl, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error(`video non scaricato: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const size = buf.length;
  if (size < 5000) throw new Error('video troppo piccolo o non valido');
  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 };
  const endpoint = direct()
    ? 'https://open.tiktokapis.com/v2/post/publish/video/init/'
    : 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
  let body = { source_info };
  if (direct()) {
    const post_info = { title: String(title).slice(0, 2200), privacy_level: env('TIKTOK_PRIVACY', 'PUBLIC_TO_EVERYONE'), disable_duet: false, disable_comment: false, disable_stitch: false };
    // TikTok considera la lettura di creator_info un passo obbligatorio della pubblicazione
    // diretta: privacy_level deve essere fra quelli permessi e le interazioni che il creatore
    // ha disattivato vanno rispettate. Se la lettura fallisce si prosegue com'era prima.
    try {
      const info = ((await creatorInfo()) || {}).data || {};
      const ammessi = info.privacy_level_options || [];
      if (ammessi.length && !ammessi.includes(post_info.privacy_level)) {
        const ripiego = ammessi.includes('SELF_ONLY') ? 'SELF_ONLY' : ammessi[0];
        warn(`privacy_level ${post_info.privacy_level} non permesso per questo account: uso ${ripiego}`);
        post_info.privacy_level = ripiego;
      }
      if (info.comment_disabled) post_info.disable_comment = true;
      if (info.duet_disabled) post_info.disable_duet = true;
      if (info.stitch_disabled) post_info.disable_stitch = true;
    } catch (e) { warn('creator_info non letto, uso i valori predefiniti:', e.message); }
    body = { post_info, source_info };
  }
  onProgress('apro il caricamento');
  const init = await post(endpoint, body, token);
  const { publish_id, upload_url } = init.data || {};
  if (!upload_url) throw new Error('TikTok non ha restituito upload_url');
  onProgress('carico il video');
  const up = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}` },
    body: buf, signal: AbortSignal.timeout(300000),
  });
  if (!up.ok) throw new Error(`caricamento fallito: ${up.status} ${(await up.text().catch(() => '')).slice(0, 160)}`);

  // TikTok elabora DOPO il caricamento: un 201 non garantisce che il video arrivi né in bozza
  // né in feed. Senza questo controllo un FAILED resta invisibile e il reel viene segnato
  // come fatto. Regola: solo un FAILED esplicito annulla; ogni altro esito (anche uno stato
  // illeggibile) lascia il comportamento di prima, così un caricamento buono non diventa
  // mai un falso errore.
  onProgress('TikTok sta elaborando');
  let esito = '';
  let motivo = '';
  let errori = 0;
  for (let i = 0; publish_id && i < 20; i++) {          // fino a ~2 minuti
    await new Promise(r => setTimeout(r, 6000));
    let s;
    try { s = await statusDetail(publish_id); errori = 0; }
    catch (e) { warn('stato non leggibile:', e.message); if (++errori >= 3) break; continue; }
    if (s.status !== esito) { esito = s.status; onProgress(`stato ${esito}`); }
    motivo = s.fail_reason || motivo;
    if (esito === 'FAILED') throw new Error(`TikTok ha rifiutato il video durante l'elaborazione${motivo ? ` (${motivo})` : ''}`);
    if (esito === 'PUBLISH_COMPLETE' || esito === 'SEND_TO_USER_INBOX') break;
  }
  const confermato = esito === 'PUBLISH_COMPLETE' || esito === 'SEND_TO_USER_INBOX';
  log(`${direct() ? 'pubblicato' : 'mandato in bozza'}: ${publish_id} (${(size / 1048576).toFixed(1)} MB) stato ${esito || 'sconosciuto'}`);
  return { publish_id, mode: direct() ? 'diretta' : 'bozza', status: esito || 'UNKNOWN', pending: !confermato };
}

/** stato dettagliato di una pubblicazione: { status, fail_reason } */
async function statusDetail(publish_id) {
  const token = await accessToken();
  const j = await post('https://open.tiktokapis.com/v2/post/publish/status/fetch/', { publish_id }, token);
  const d = (j && j.data) || {};
  return { status: d.status || 'UNKNOWN', fail_reason: d.fail_reason || '' };
}

/** stato di una pubblicazione: PROCESSING_UPLOAD | PUBLISH_COMPLETE | FAILED … */
const status = async (publish_id) => (await statusDetail(publish_id)).status;

module.exports = { configured, linkable, direct, me, creatorInfo, sendVideo, status, statusDetail, authUrl, exchangeCode, setRefresh, setOnRotate, redirectUri };
