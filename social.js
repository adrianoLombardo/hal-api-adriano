/* ════════════════════════════════════════════════
   REEL SU INSTAGRAM E TIKTOK — promemoria con tutto pronto
   Mezz'ora prima di ogni slot del calendario (campaign/reels/v2/publishing-kit.md,
   compilato in social-plan.json) il bot manda ad Adriano:
     video pronto da salvare nel rullino · copertina consigliata · didascalia Instagram
     con hashtag da copiare con un tocco · didascalia TikTok · testo alternativo
   Adriano pubblica dal telefono e segna «Pubblicato» con i pulsanti.
   Nessuna API di Meta o TikTok: nessuna approvazione, nessun account business.
   Variabili: SOCIAL_HOUR (default 18, invio 30 min prima dello slot), SOCIAL_ENABLED=0 per spegnere.
   Usa il bot del blog (blog.js registra il modulo): stesso token, un solo lettore di aggiornamenti.
   ──────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');

const crypto = require('crypto');
const ig = require('./publish-ig');
const fb = require('./publish-fb');
const tiktok = require('./publish-tiktok');

const env = (k, d = '') => (process.env[k] || d).trim();
const TZ = 'Europe/Rome';
const PLAN_FILE = path.join(__dirname, 'social-plan.json');
const log = (...a) => console.log('[SOCIAL]', ...a);
const warn = (...a) => console.warn('[SOCIAL]', ...a);

let bot = null;           // API esposta da blog.js: { tg, send, owner, notifyOwner, registerModule }
let STATE_FILE = null;
let state = null;
let busy = false;

/* ── stato ── */
function defaultState() { return { paused: false, sent: {}, done: {}, postponed: {}, lastTikTokPing: {}, igToken: null, igTokenAt: null, edits: {}, schedule: {}, ttRefresh: null, ttOpenId: null, ttAt: null }; }
function loadState() {
  try { state = Object.assign(defaultState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch (e) { state = defaultState(); }
}
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { warn('salvataggio stato:', e.message); } }
function plan() {
  try { return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); } catch (e) { return { items: [] }; }
}
/** reel in calendario, con lo slot assegnato e le modifiche fatte da Telegram */
const withEdits = (it) => {
  const base = { ...it, ...(state.edits[it.id] || {}) };
  if (state.postponed[it.id]) return { ...base, date: state.postponed[it.id] };
  const s = (state.schedule || {})[it.id];
  return s ? { ...base, date: s.date, time: s.time, tiktokTime: s.tiktokTime } : base;
};
function items() {
  return plan().items.map(withEdits)
    .filter(it => !it.skipped)
    .sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
}
function findItem(id) { const it = plan().items.find(x => x.id === id); return it ? withEdits(it) : null; }

/* ── slot del calendario ────────────────────────────────────────────────
   Gli slot sono le date previste dal piano. Non appartengono a un reel:
   sono posti in fila. Quando un reel viene pubblicato esce dalla coda e
   i successivi scalano in avanti, così pubblicare in anticipo non lascia
   buchi e non allunga la serie. `reschedule()` va richiamata a ogni
   cambio di stato (pubblicato, rimandato, ripristinato).            */
function slotList() {
  const s = plan().items.filter(i => !i.skipped && i.date)
    .map(i => ({ date: i.date, time: i.time, tiktokTime: i.tiktokTime }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return s;
}
/** passo medio fra uno slot e il successivo, per prolungare il calendario se serve */
function slotStep(list) {
  if (list.length < 2) return 4;
  const g = [];
  for (let i = 1; i < list.length; i++) g.push(Math.round((Date.parse(list[i].date) - Date.parse(list[i - 1].date)) / 86400000));
  const ok = g.filter(n => n > 0);
  return ok.length ? Math.max(1, Math.round(ok.reduce((a, b) => a + b, 0) / ok.length)) : 4;
}
function reschedule() {
  const oggi = todayIso();
  const coda = plan().items
    .filter(i => !i.skipped && !isDone(i.id))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // le date fissate a mano con /rimanda non vengono riassegnate a nessun altro
  const fissate = new Set(coda.map(i => state.postponed[i.id]).filter(Boolean));
  const tutti = slotList();
  const liberi = tutti.filter(s => s.date >= oggi && !fissate.has(s.date));
  const step = slotStep(tutti);
  const nuovo = {};
  let k = 0;
  for (const it of coda) {
    if (state.postponed[it.id]) continue;
    if (!liberi[k]) {
      // finiti gli slot del piano: prolungo con lo stesso passo
      const ultimo = liberi[k - 1] || tutti[tutti.length - 1] || { date: oggi, time: '18:30', tiktokTime: '20:00' };
      liberi[k] = { date: addDays(ultimo.date, step), time: ultimo.time, tiktokTime: ultimo.tiktokTime };
    }
    nuovo[it.id] = liberi[k++];
  }
  state.schedule = nuovo;
  saveState();
  return nuovo;
}
/** segna un reel come pubblicato e lo toglie dal calendario, facendo scalare gli altri */
function markDone(id, patch) {
  state.done[id] = { ...(state.done[id] || {}), ...patch };
  delete state.postponed[id];
  delete state.sent[id];
  saveState();
  reschedule();
}
/** riga da mostrare dopo una pubblicazione: chi è uscito e cosa viene dopo */
function afterPublish(it) {
  const next = items().find(x => !isDone(x.id));
  const fuori = `🗓 Reel ${it.reel} tolto dal calendario.`;
  return next
    ? `${fuori} Gli altri scalano: prossimo il reel ${next.reel} · ${esc(next.title)} — ${esc(dateIt(next.date))}.`
    : `${fuori} Non resta altro in calendario 🎉`;
}
function setEdit(id, patch) { state.edits[id] = { ...(state.edits[id] || {}), ...patch }; saveState(); }
const isDone = (id) => !!(state.done[id] && state.done[id].instagram);

/* ── date in Europa/Roma ── */
function romeParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute };
}
function romeOffsetMin(ms) { const r = romeParts(ms); return Math.round((Date.UTC(r.y, r.m - 1, r.d, r.h, r.min) - ms) / 60000); }
function atRome(iso, hh, mm = 0) {
  const [y, m, d] = iso.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return guess - romeOffsetMin(guess) * 60000;
}
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
function dateIt(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const g = GIORNI[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${g} ${d} ${MESI[m - 1]}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
function todayIso(ms = Date.now()) { const r = romeParts(ms); return `${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}`; }

/* ── testo ── */
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pre = (s) => `<pre>${esc(s)}</pre>`;           // blocco con copia in un tocco sui client mobili
const igFull = (it) => `${it.instagram}\n\n${it.hashtags.join(' ')}`;
const at = (u) => '@' + String(u || '').replace(/^@+/, '');
const tagLine = (it) => {
  const p = [];
  if ((it.userTags || []).length) p.push(`🏷 Tag: ${it.userTags.map(at).join(' ')}`);
  if ((it.collaborators || []).length) p.push(`🤝 Collaboratori: ${it.collaborators.map(at).join(' ')}`);
  return p.join('\n');
};
/** secondo del fotogramma consigliato per la copertina: "0,3 s, silhouette…" → "0,3 s" (la virgola è decimale) */
const coverTime = (it) => { const m = /^\s*([\d]+(?:[.,]\d+)?\s*s)/.exec(it.coverNote || ''); return m ? m[1] : ''; };
const sendHour = () => Math.min(23, Math.max(0, Number(env('SOCIAL_HOUR', '18')) || 18));
const sendAtMs = (it) => it.date ? atRome(it.date, sendHour(), 0) : null;
const slotMs = (it) => it.date ? atRome(it.date, 18, 30) : null;
const tiktokMs = (it) => it.date ? atRome(it.date, 20, 0) : null;

function keyboard(it) {
  const rows = [];
  if (ig.configured()) rows.push([{ text: '🚀 Pubblica su Instagram', callback_data: `rl:pig:${it.id}` }]);
  else rows.push([{ text: '✅ Pubblicato su Instagram', callback_data: `rl:ig:${it.id}` }]);
  if (tiktok.configured()) rows.push([{ text: tiktok.direct() ? '🚀 Pubblica su TikTok' : '📥 Manda a TikTok (bozza)', callback_data: `rl:ptt:${it.id}` }]);
  else rows.push([{ text: '🎵 Pubblicato su TikTok', callback_data: `rl:tt:${it.id}` }]);
  if (fb.configured()) rows.push([{ text: '📘 Pubblica su Facebook', callback_data: `rl:pfb:${it.id}` }]);
  rows.push([{ text: '✏️ Cambia didascalia', callback_data: `rl:edcap:${it.id}` }, { text: '🏷 Tag e collaboratori', callback_data: `rl:edtag:${it.id}` }]);
  rows.push([{ text: '⏭ Rimanda di 3 giorni', callback_data: `rl:pp:${it.id}` }]);
  if (ig.configured()) rows.push([{ text: '✍️ L\'ho pubblicato a mano', callback_data: `rl:ig:${it.id}` }]);
  return { inline_keyboard: rows };
}

/* ── pubblicazione vera ── */
async function doPublishInstagram(it, chatId) {
  const send = (t) => bot.send(chatId, t);
  await send(`🚀 Pubblico il reel ${it.reel} su Instagram. Il caricamento richiede uno o due minuti…`);
  const r = await ig.publishReel({
    videoUrl: it.video, caption: igFull(it), coverUrl: it.cover, shareToFeed: true,
    userTags: it.userTags || [], collaborators: it.collaborators || [],
    onProgress: (st) => log(`reel ${it.id}: ${st}`),
  });
  markDone(it.id, { instagram: Date.now(), instagramId: r.id, permalink: r.permalink || null });
  await send(`✅ <b>Pubblicato su Instagram</b>${r.permalink ? `\n${r.permalink}` : ''}\n\nRicordati della copertina: in Instagram puoi cambiarla dal fotogramma a ${esc(coverTime(it) || '—')}.\n${afterPublish(it)}`);
  if (fb.configured()) await send('📘 Vuoi anche su Facebook? Premi «Pubblica su Facebook» qui sopra.');
  if (tiktok.configured()) await send('Alle 20:00 ti ricordo TikTok, oppure premi ora il pulsante di TikTok qui sopra.');
}

async function doPublishFacebook(it, chatId) {
  const send = (t) => bot.send(chatId, t);
  await send(`📘 Pubblico il reel ${it.reel} sulla Pagina Facebook…`);
  const r = await fb.publishReel({ videoUrl: it.video, description: igFull(it), onProgress: (st) => log(`reel ${it.id} facebook: ${st}`) });
  markDone(it.id, { facebook: Date.now(), facebookId: r.id, facebookLink: r.permalink || null });
  await send(r.pending
    ? `📘 Reel ${it.reel} caricato su Facebook: sta ancora elaborando, comparirà tra qualche minuto.\n${esc(r.permalink)}`
    : `✅ <b>Pubblicato su Facebook</b>\n${esc(r.permalink)}`);
}

async function doPublishTikTok(it, chatId) {
  const send = (t) => bot.send(chatId, t);
  await send(`${tiktok.direct() ? '🚀 Pubblico' : '📥 Mando'} il reel ${it.reel} su TikTok…`);
  const r = await tiktok.sendVideo({ videoUrl: it.video, title: it.tiktok, onProgress: (st) => log(`reel ${it.id} tiktok: ${st}`) });
  markDone(it.id, { tiktok: Date.now(), tiktokId: r.publish_id, instagram: (state.done[it.id] || {}).instagram || Date.now() });
  await send(r.mode === 'bozza'
    ? `📥 <b>Video su TikTok</b>, nelle bozze.\nApri l'app TikTok → notifiche o bozze → aggiungi la didascalia (te l'ho mandata sopra) e pubblica.`
    : `✅ <b>Pubblicato su TikTok</b> (id ${esc(r.publish_id)}).`);
}

/* ── invio del pacchetto ── */
async function sendPackage(it, chatId, { manual = false } = {}) {
  const to = chatId || bot.owner();
  if (!to) throw new Error('proprietario Telegram non collegato: manda /start al bot');
  if (busy) throw new Error('sto già inviando un reel, riprova tra un minuto');
  busy = true;
  try {
    const when = it.date ? `${dateIt(it.date)} alle ${it.time}` : 'quando vuoi';
    const head = `🎬 <b>Reel ${it.reel} · ${esc(it.title)}</b>\nInstagram ${esc(when)} · TikTok alle ${esc(it.tiktokTime)}${coverTime(it) ? `\n🖼 Copertina: fotogramma a ${esc(coverTime(it))}` : ''}`;
    try {
      await bot.tg('sendVideo', { chat_id: to, video: it.video, caption: head, parse_mode: 'HTML', supports_streaming: true, width: 1080, height: 1920 });
    } catch (e) {
      warn('sendVideo fallito, mando il link:', e.message);
      await bot.send(to, `${head}\n\n⚠️ Video non allegato (${esc((e.message || '').slice(0, 120))}). Scaricalo qui: ${it.video}`);
    }
    try { await bot.tg('sendPhoto', { chat_id: to, photo: it.cover, caption: `Copertina consigliata${it.coverNote ? ' (' + esc(it.coverNote) + ')' : ''}. Puoi anche sceglierla dalla timeline in Instagram.`, parse_mode: 'HTML' }); } catch (e) { warn('copertina:', e.message); }
    const tl = tagLine(it);
    await bot.send(to, `📄 <b>Didascalia Instagram</b> — tocca per copiare\n${pre(igFull(it))}${tl ? '\n' + esc(tl) : ''}`);
    let extra = `🎵 <b>TikTok</b> (${esc(it.tiktokTime)}) — tocca per copiare\n${pre(it.tiktok)}`;
    if (it.alt) extra += `\n\n♿ <b>Testo alternativo</b> (Instagram → Impostazioni avanzate)\n${pre(it.alt)}`;
    if (it.english) extra += `\n\n🇬🇧 <i>Versione inglese, se la vuoi aggiungere:</i>\n${pre(it.english)}`;
    await bot.send(to, extra);
    const auto = ig.configured() || tiktok.configured();
    await bot.send(to, `${auto ? 'Premi qui sotto e pubblico io.' : "Quando l'hai pubblicato, segnalo qui sotto."}${manual ? '' : '\n<i>Promemoria automatico: mancano 30 minuti allo slot.</i>'}`, { reply_markup: keyboard(it) });
    if (!manual) { state.sent[it.id] = Date.now(); saveState(); }
    log(`pacchetto inviato: reel ${it.id} (${it.title})`);
  } finally { busy = false; }
}

/* ── token Instagram: dura 60 giorni, si rinnova quando ha almeno 24 h di vita ── */
async function refreshIgToken({ force = false } = {}) {
  if (!ig.configured()) return;
  const age = state.igTokenAt ? Date.now() - state.igTokenAt : Infinity;
  if (!force && age < 20 * 86400 * 1000) return;          // rinnovo ogni 20 giorni
  try {
    const r = await ig.refreshToken();
    if (r && r.access_token) {
      state.igToken = r.access_token; state.igTokenAt = Date.now(); saveState();
      ig.setToken(r.access_token);
      log(`token Instagram rinnovato, scade tra ${Math.round((r.expires_in || 0) / 86400)} giorni`);
    }
  } catch (e) { warn('rinnovo token Instagram:', (e.message || '').slice(0, 200)); }
}

/* ── scheduler ── */
async function tick() {
  if (!bot || !bot.owner() || state.paused || env('SOCIAL_ENABLED') === '0') return;
  const now = Date.now();
  for (const it of items()) {
    if (!it.date || isDone(it.id)) continue;
    const at = sendAtMs(it);
    if (at && now >= at && !state.sent[it.id] && now - at < 12 * 3600 * 1000) {
      try { await sendPackage(it); } catch (e) { warn('invio automatico:', e.message); }
      return; // uno per giro
    }
    // promemoria TikTok alle 20:00 se Instagram è fatto e TikTok no
    const tt = tiktokMs(it);
    const d = state.done[it.id];
    if (tt && now >= tt && now - tt < 4 * 3600 * 1000 && d && d.instagram && !d.tiktok && !state.lastTikTokPing[it.id]) {
      state.lastTikTokPing[it.id] = Date.now(); saveState();
      try { await bot.notifyOwner(`🎵 <b>TikTok</b> — è l'ora del reel ${it.reel} · ${esc(it.title)}\n${pre(it.tiktok)}`, { reply_markup: { inline_keyboard: [[{ text: '🎵 Pubblicato su TikTok', callback_data: `rl:tt:${it.id}` }]] } }); } catch (e) {}
      return;
    }
  }
}

/* ── revisione del testo: il prossimo messaggio libero arriva qui ── */
let awaiting = null;   // { id, field: 'caption' | 'tags', chatId }
let ttState = null;    // csrf dell'autorizzazione TikTok in corso

function parseHandles(text) {
  const [left, right] = String(text).split('|');
  const grab = (s) => (s || '').split(/[\s,;]+/).map(x => x.trim().replace(/^@+/, '')).filter(x => /^[a-z0-9._]{1,30}$/i.test(x));
  return { tags: grab(left), collaborators: grab(right).slice(0, 3) };
}

async function onText(text, chatId) {
  if (!awaiting) return;
  const it = findItem(awaiting.id);
  const field = awaiting.field;
  if (/^annulla$/i.test(text.trim())) { awaiting = null; return bot.send(chatId, 'Lasciato com\'era.'); }
  if (!it) { awaiting = null; return bot.send(chatId, 'Reel non trovato.'); }
  if (field === 'caption') {
    const hashtags = (text.match(/#[\p{L}\p{N}_]+/gu) || []);
    const body = text.replace(/\n?(#[\p{L}\p{N}_]+\s*)+$/u, '').trim();
    setEdit(it.id, { instagram: body, ...(hashtags.length ? { hashtags } : {}) });
    awaiting = null;
    const nuovo = findItem(it.id);
    return bot.send(chatId, `✏️ <b>Didascalia aggiornata</b> per il reel ${it.reel}. Ecco come esce:\n${pre(igFull(nuovo))}${tagLine(nuovo) ? '\n' + esc(tagLine(nuovo)) : ''}`, { reply_markup: keyboard(nuovo) });
  }
  if (field === 'tags') {
    if (/^nessuno$/i.test(text.trim())) { setEdit(it.id, { userTags: [], collaborators: [] }); }
    else {
      const { tags, collaborators } = parseHandles(text);
      if (!tags.length && !collaborators.length) return bot.send(chatId, 'Non ho riconosciuto nomi utente validi. Riprova, per esempio: <code>@holyclub @sublimetecnologico | @holyclub</code>');
      setEdit(it.id, { userTags: tags, collaborators });
    }
    awaiting = null;
    const nuovo = findItem(it.id);
    return bot.send(chatId, `🏷 <b>Aggiornato</b> per il reel ${it.reel}.\n${esc(tagLine(nuovo) || 'Nessun tag e nessun collaboratore.')}\n\n<i>I profili taggati devono permettere i tag; i collaboratori ricevono un invito da accettare nell'app.</i>`, { reply_markup: keyboard(nuovo) });
  }
}

/* ── comandi ── */
function statusText() {
  const list = items();
  // i pubblicati escono dal calendario: restano solo quelli ancora da fare
  const attivi = list.filter(it => !isDone(it.id));
  // anche i reel fuori calendario, se pubblicati dal bot, vanno nella riga dei fatti
  const fatti = plan().items
    .filter(i => isDone(i.id) && !(i.skipped && i.status !== 'hold'))
    .map(withEdits);
  const rows = attivi.map(it => `${state.sent[it.id] ? '📤' : '•'} ${it.date ? dateIt(it.date) : '—'} · reel ${it.reel} ${it.title}`);
  const fattiRiga = fatti.length
    ? `Pubblicati dal bot: ${fatti.map(it => { const d = state.done[it.id] || {}; return `reel ${it.reel} ${d.tiktok ? '✅' : '📸'} ${dateIt(todayIso(d.instagram || d.facebook || Date.now()))}`; }).join(' · ')}`
    : '';
  const doneN = fatti.length;
  const out = plan().items.filter(i => i.skipped);
  const pub = out.filter(i => i.status !== 'hold').map(i => `reel ${i.reel}`);
  const held = out.filter(i => i.status === 'hold' && !isDone(i.id)).map(i => `reel ${i.reel} ${i.title}`);
  return [
    `Calendario reel — ${doneN} su ${attivi.length + fatti.length} pubblicati${state.paused ? ' (IN PAUSA)' : ''}`,
    ...(rows.length ? rows : ['Nessun reel in calendario.']),
    fattiRiga,
    pub.length ? `Già pubblicati a mano: ${pub.join(', ')}` : '',
    held.length ? `In attesa (non opere): ${held.join(' · ')} — /reel <numero> per mandarne uno` : '',
    '',
    `Pubblicazione: Instagram ${ig.configured() ? 'automatica' : 'a mano'} · Facebook ${fb.configured() ? 'automatica' : 'a mano'} · TikTok ${tiktok.configured() ? (tiktok.direct() ? 'automatica' : 'in bozza') : 'a mano'}`,
    'Legenda: • in attesa · 📤 inviato · 📸 su Instagram · ✅ anche su TikTok',
    'Un reel pubblicato esce dal calendario e gli altri scalano negli slot liberi.',
  ].filter(Boolean).join('\n');
}

const HELP = `Reel (Instagram e TikTok):
/reel — manda subito il prossimo pacchetto (anche: /reel 3)
/reels — calendario, stato e pulsanti per scegliere quale reel pubblicare ora
/didascalia 3 — riscrivi la didascalia del reel 3
/tag 3 — scegli chi taggare e i collaboratori
/pubblicareel 3 — pubblica subito il reel 3 su Instagram
/pubblicafb 3 — pubblica il reel 3 sulla Pagina Facebook
/tiktok — collega l'account TikTok (una volta sola)
/social — stato dei collegamenti Instagram e TikTok
/pubblicato 3 — segna il reel 3 come pubblicato (se l'hai fatto a mano)
/rimanda 3 — sposta il reel 3 di 3 giorni
/reelpausa e /reelriprendi — ferma o riattiva i promemoria`;

function findReel(arg) {
  const n = String(arg || '').replace(/[^0-9]/g, '');
  if (!n) return null;
  const raw = plan().items.find(it => it.reel === Number(n));
  return items().find(it => it.reel === Number(n)) || (raw ? withEdits(raw) : null);
}

async function onCommand(cmd, arg, chatId) {
  const send = (t, e) => bot.send(chatId, t, e);
  switch (cmd) {
    case 'reel': {
      let it = arg ? findReel(arg) : null;
      if (arg && !it) return send(`Reel ${esc(arg)} non trovato. /reels per la lista.`);
      if (!it) it = items().find(x => !isDone(x.id) && !state.sent[x.id]) || items().find(x => !isDone(x.id));
      if (!it) return send('Tutti i reel sono pubblicati 🎉');
      await send(`⏳ Preparo il pacchetto del reel ${it.reel}…`);
      return sendPackage(it, chatId, { manual: true });
    }
    case 'reels': {
      const scegli = [];
      const liberi = items().filter(x => !isDone(x.id));
      const attesa = plan().items.filter(i => i.skipped && i.status === 'hold' && !isDone(i.id)).map(withEdits);
      for (const x of [...liberi, ...attesa]) {
        scegli.push({ text: `▶️ ${x.reel} · ${String(x.title).slice(0, 24)}`, callback_data: `rl:go:${x.id}` });
      }
      const rows = [];
      for (let i = 0; i < scegli.length; i += 2) rows.push(scegli.slice(i, i + 2));
      return send(esc(statusText()) + (rows.length ? '\n\n<i>Tocca un reel per averne subito il pacchetto, anche fuori calendario.</i>' : ''),
        rows.length ? { reply_markup: { inline_keyboard: rows } } : undefined);
    }
    case 'pubblicato': {
      const it = findReel(arg);
      if (!it) return send('Quale reel? Esempio: /pubblicato 3');
      markDone(it.id, { instagram: Date.now() });
      return send(`✅ Reel ${it.reel} segnato come pubblicato su Instagram.\n${afterPublish(it)}`);
    }
    case 'rimanda': {
      const it = findReel(arg);
      if (!it || !it.date) return send('Quale reel? Esempio: /rimanda 3');
      state.postponed[it.id] = addDays(it.date, 3);
      delete state.sent[it.id]; saveState(); reschedule();
      return send(`⏭ Reel ${it.reel} spostato a ${esc(dateIt(state.postponed[it.id]))}. Gli altri si sono risistemati negli slot liberi.`);
    }
    case 'pubblicareel': {
      const it = findReel(arg) || items().find(x => !isDone(x.id));
      if (!it) return send('Quale reel? Esempio: /pubblicareel 3');
      if (!ig.configured()) return send('Instagram non è ancora collegato: /social per lo stato.');
      return doPublishInstagram(it, chatId);
    }
    case 'pubblicafb': {
      const it = findReel(arg) || items().find(x => !isDone(x.id));
      if (!it) return send('Quale reel? Esempio: /pubblicafb 3');
      if (!fb.configured()) return send('Facebook non è ancora collegato: /social per lo stato.');
      return doPublishFacebook(it, chatId);
    }
    case 'tiktok': {
      if (!tiktok.linkable()) return send('TikTok: mancano ancora <code>TIKTOK_CLIENT_KEY</code> e <code>TIKTOK_CLIENT_SECRET</code> su Railway.');
      if (tiktok.configured() && !/rifai|nuovo|forza/i.test(String(arg || ''))) {
        try { const m = await tiktok.me(); return send(`🎵 TikTok è già collegato come ${esc(m.display_name || m.open_id)}.\nPer rifare il collegamento: <code>/tiktok rifai</code>`); }
        catch (e) {}
      }
      ttState = crypto.randomBytes(12).toString('hex');
      return send(`🎵 <b>Collega TikTok</b>\nApri questo link e autorizza l'app. Il collegamento si chiude da solo.\n\n${esc(tiktok.authUrl(ttState))}`, { disable_web_page_preview: true });
    }
    case 'rinnovatoken': {
      await refreshIgToken({ force: true });
      const quando = state.igTokenAt ? new Date(state.igTokenAt).toLocaleDateString('it-IT') : 'mai';
      return send(`Token Instagram: ultimo rinnovo ${esc(quando)}. Usa /social per verificarlo.`);
    }
    case 'didascalia': case 'tag': {
      const it = findReel(arg);
      if (!it) return send(`Quale reel? Esempio: /${cmd} 3`);
      awaiting = { id: it.id, field: cmd === 'didascalia' ? 'caption' : 'tags', chatId };
      return send(cmd === 'didascalia'
        ? `✏️ Mandami la nuova didascalia del reel ${it.reel}. Ecco quella attuale:\n${pre(igFull(findItem(it.id)))}`
        : `🏷 Mandami i nomi utente da taggare nel reel ${it.reel} (collaboratori dopo una barra verticale).\nOra: ${esc(tagLine(findItem(it.id)) || 'nessuno')}`);
    }
    case 'social': {
      const righe = ['<b>Collegamenti social</b>'];
      if (ig.configured()) {
        try { const m = await ig.me(); righe.push(`📸 Instagram: collegato come @${esc(m.username || m.id)} (${esc(ig.host())})`); }
        catch (e) { righe.push(`📸 Instagram: token NON valido — ${esc((e.message || '').slice(0, 160))}`); }
      } else righe.push('📸 Instagram: non configurato (IG_USER_ID, IG_ACCESS_TOKEN)');
      if (tiktok.configured()) {
        try { const m = await tiktok.me(); righe.push(`🎵 TikTok: collegato come ${esc(m.display_name || m.open_id || '?')} — modalità ${tiktok.direct() ? 'pubblicazione diretta' : 'bozza'}`); }
        catch (e) { righe.push(`🎵 TikTok: token NON valido — ${esc((e.message || '').slice(0, 160))}`); }
      } else if (tiktok.linkable()) righe.push('🎵 TikTok: app pronta, account da collegare — manda /tiktok');
      else righe.push('🎵 TikTok: non configurato (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET)');
      if (fb.configured()) {
        try {
          const m = await fb.me();
          let nota = '';
          try { const t = await fb.tokenInfo(); nota = t.expiresAt ? ` — token valido fino al ${new Date(t.expiresAt * 1000).toLocaleDateString('it-IT')}` : ' — token senza scadenza'; } catch (e) {}
          righe.push(`📘 Facebook: Pagina «${esc(m.name || m.id)}» via ${esc(fb.mode())}${esc(nota)}`);
        } catch (e) { righe.push(`📘 Facebook: token NON valido — ${esc((e.message || '').slice(0, 160))}`); }
      } else righe.push('📘 Facebook: non configurato (FB_PAGE_ID + FB_USER_TOKEN oppure FB_PAGE_TOKEN)');
      return send(righe.join('\n'));
    }
    case 'reelpausa': state.paused = true; saveState(); return send('Promemoria dei reel in pausa. /reelriprendi per riattivarli.');
    case 'reelriprendi': state.paused = false; saveState(); return send('Promemoria dei reel riattivati.');
  }
}

async function onCallback(action, id, cb) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const it = findItem(id);
  if (!it) return bot.send(chatId, 'Reel non trovato.');
  const d = state.done[it.id] || { instagram: null, tiktok: null };
  if (action === 'ig') {
    markDone(it.id, { instagram: Date.now() });
    return bot.send(chatId, `✅ Reel ${it.reel} pubblicato su Instagram.\n${afterPublish(it)}`);
  }
  if (action === 'tt') {
    markDone(it.id, { tiktok: Date.now(), instagram: d.instagram || Date.now() });
    return bot.send(chatId, `🎵 Reel ${it.reel} segnato anche su TikTok. ${items().filter(x => !isDone(x.id)).length} reel ancora in calendario.`);
  }
  if (action === 'go') {
    await bot.send(chatId, `⏳ Preparo il pacchetto del reel ${it.reel}…`);
    return sendPackage(it, chatId, { manual: true });
  }
  if (action === 'pig') {
    if (isDone(it.id) && d.instagramId) return bot.send(chatId, `Il reel ${it.reel} è già stato pubblicato${d.permalink ? ': ' + d.permalink : ''}.`);
    try { return await doPublishInstagram(it, chatId); }
    catch (e) { warn('pubblicazione IG:', e.message); return bot.send(chatId, `❌ Instagram non ha accettato il reel ${it.reel}:\n<code>${esc((e.message || '').slice(0, 400))}</code>\n\nPuoi pubblicarlo a mano dal telefono e premere «L'ho pubblicato a mano».`); }
  }
  if (action === 'ptt') {
    try { return await doPublishTikTok(it, chatId); }
    catch (e) { warn('pubblicazione TikTok:', e.message); return bot.send(chatId, `❌ TikTok non ha accettato il reel ${it.reel}:\n<code>${esc((e.message || '').slice(0, 400))}</code>`); }
  }
  if (action === 'pfb') {
    if (d.facebookId) return bot.send(chatId, `Il reel ${it.reel} è già su Facebook${d.facebookLink ? ': ' + d.facebookLink : ''}.`);
    try { return await doPublishFacebook(it, chatId); }
    catch (e) { warn('pubblicazione Facebook:', e.message); return bot.send(chatId, `❌ Facebook non ha accettato il reel ${it.reel}:\n<code>${esc((e.message || '').slice(0, 400))}</code>`); }
  }
  if (action === 'edcap' || action === 'edtag') {
    awaiting = { id: it.id, field: action === 'edcap' ? 'caption' : 'tags', chatId };
    return bot.send(chatId, action === 'edcap'
      ? `✏️ Mandami la <b>nuova didascalia</b> del reel ${it.reel} in un messaggio.\nGli hashtag li rimetto io in fondo (${it.hashtags.length}); se ne scrivi di tuoi uso i tuoi.\nScrivi <code>annulla</code> per lasciare tutto com'è.`
      : `🏷 Mandami i nomi utente da taggare nel reel ${it.reel}, separati da spazio.\nPer i collaboratori (massimo 3, devono accettare l'invito su Instagram) scrivili dopo una barra verticale:\n<code>@holyclub @sublimetecnologico | @holyclub</code>\nScrivi <code>nessuno</code> per toglierli, <code>annulla</code> per lasciare tutto com'è.`);
  }
  if (action === 'pp') {
    if (!it.date) return bot.send(chatId, 'Questo reel non è in calendario.');
    state.postponed[it.id] = addDays(state.postponed[it.id] || it.date, 3);
    delete state.sent[it.id]; saveState(); reschedule();
    return bot.send(chatId, `⏭ Reel ${it.reel} spostato a ${esc(dateIt(state.postponed[it.id]))}.`);
  }
}

/* ── init ── */
function init({ app, dataDir, adminAuth, blog }) {
  bot = blog;
  STATE_FILE = path.join(dataDir || __dirname, 'social-state.json');
  loadState();
  const p = plan();
  if (!p.items || !p.items.length) { warn('social-plan.json assente o vuoto: modulo spento'); return; }
  reschedule();
  if (state.ttRefresh) tiktok.setRefresh(state.ttRefresh);

  bot.registerModule({
    name: 'social',
    commands: ['reel', 'reels', 'pubblicato', 'rimanda', 'reelpausa', 'reelriprendi', 'pubblicareel', 'pubblicafb', 'social', 'rinnovatoken', 'didascalia', 'tag', 'tiktok'],
    prefixes: ['rl'],
    help: HELP,
    onCommand,
    onCallback,
    wantsText: () => !!awaiting,
    onText,
  });

  // ritorno dell'autorizzazione TikTok: nessuna password, il codice arriva da TikTok
  app.get('/api/tiktok/callback', async (req, res) => {
    const pagina = (titolo, testo) => res.status(200).type('html').send(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${titolo}</title><style>body{background:#020a0d;color:#e9f6f6;font:16px/1.6 system-ui,sans-serif;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:2rem;text-align:center}` +
      `b{color:#0af5f5}</style><div><h1>${titolo}</h1><p>${testo}</p></div>`);
    try {
      if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
      const code = String(req.query.code || '');
      if (!code) throw new Error('codice mancante');
      if (!ttState || String(req.query.state || '') !== ttState) throw new Error('richiesta non riconosciuta: rilancia /tiktok sul bot');
      ttState = null;
      const t = await tiktok.exchangeCode(code);
      state.ttRefresh = t.refresh_token; state.ttOpenId = t.open_id || null; state.ttAt = Date.now();
      saveState();
      tiktok.setRefresh(t.refresh_token);
      log('TikTok collegato');
      try { await bot.notifyOwner('🎵 <b>TikTok collegato.</b> Da ora il pacchetto dei reel ha il pulsante per mandare il video nelle bozze di TikTok.'); } catch (e) {}
      return pagina('TikTok collegato', 'Puoi chiudere questa pagina e tornare su Telegram.');
    } catch (e) {
      warn('callback TikTok:', e.message);
      return pagina('Collegamento non riuscito', `<b>${esc((e.message || '').slice(0, 200))}</b><br>Rilancia /tiktok sul bot.`);
    }
  });

  app.get('/api/admin/reels', adminAuth, (req, res) => res.json({ status: statusText(), state }));
  app.post('/api/admin/reels/send/:id', adminAuth, async (req, res) => {
    const it = plan().items.find(x => x.id === String(req.params.id).padStart(2, '0'));
    if (!it) return res.status(404).json({ error: 'reel non trovato' });
    try { await sendPackage(it, null, { manual: true }); res.json({ ok: true, reel: it.reel }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  if (state.igToken) ig.setToken(state.igToken);
  setTimeout(() => { refreshIgToken().catch(() => {}); }, 90 * 1000);
  setInterval(() => { refreshIgToken().catch(() => {}); }, 24 * 3600 * 1000);
  setInterval(() => { tick().catch(e => warn('tick:', e.message)); }, 5 * 60 * 1000);
  setTimeout(() => { tick().catch(e => warn('tick:', e.message)); }, 60 * 1000);
  const next = items().find(it => !isDone(it.id));
  log(`pronto: ${items().length} reel in calendario · prossimo ${next ? `reel ${next.reel} il ${dateIt(next.date)} (pacchetto alle ${sendHour()}:00)` : 'nessuno'}`);
}

module.exports = { init, statusText, sendPackage, _state: () => state };
