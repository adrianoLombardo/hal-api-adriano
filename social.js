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
function defaultState() { return { paused: false, sent: {}, done: {}, postponed: {}, lastTikTokPing: {} }; }
function loadState() {
  try { state = Object.assign(defaultState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch (e) { state = defaultState(); }
}
function saveState() { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { warn('salvataggio stato:', e.message); } }
function plan() {
  try { return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); } catch (e) { return { items: [] }; }
}
/** reel in calendario, con la data eventualmente rimandata da Adriano */
function items() {
  return plan().items.map(it => ({ ...it, date: state.postponed[it.id] || it.date }))
    .filter(it => !it.skipped)
    .sort((a, b) => (a.date || '9').localeCompare(b.date || '9'));
}
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
function todayIso() { const r = romeParts(Date.now()); return `${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}`; }

/* ── testo ── */
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pre = (s) => `<pre>${esc(s)}</pre>`;           // blocco con copia in un tocco sui client mobili
const igFull = (it) => `${it.instagram}\n\n${it.hashtags.join(' ')}`;
const sendHour = () => Math.min(23, Math.max(0, Number(env('SOCIAL_HOUR', '18')) || 18));
const sendAtMs = (it) => it.date ? atRome(it.date, sendHour(), 0) : null;
const slotMs = (it) => it.date ? atRome(it.date, 18, 30) : null;
const tiktokMs = (it) => it.date ? atRome(it.date, 20, 0) : null;

function keyboard(it) {
  return { inline_keyboard: [
    [{ text: '✅ Pubblicato su Instagram', callback_data: `rl:ig:${it.id}` }],
    [{ text: '🎵 Pubblicato su TikTok', callback_data: `rl:tt:${it.id}` }],
    [{ text: '⏭ Rimanda di 3 giorni', callback_data: `rl:pp:${it.id}` }],
  ] };
}

/* ── invio del pacchetto ── */
async function sendPackage(it, chatId, { manual = false } = {}) {
  const to = chatId || bot.owner();
  if (!to) throw new Error('proprietario Telegram non collegato: manda /start al bot');
  if (busy) throw new Error('sto già inviando un reel, riprova tra un minuto');
  busy = true;
  try {
    const when = it.date ? `${dateIt(it.date)} alle ${it.time}` : 'quando vuoi';
    const head = `🎬 <b>Reel ${it.reel} · ${esc(it.title)}</b>\nInstagram ${esc(when)} · TikTok alle ${esc(it.tiktokTime)}${it.coverNote ? `\n🖼 Copertina: fotogramma a ${esc(it.coverNote.split(',')[0])}` : ''}`;
    try {
      await bot.tg('sendVideo', { chat_id: to, video: it.video, caption: head, parse_mode: 'HTML', supports_streaming: true, width: 1080, height: 1920 });
    } catch (e) {
      warn('sendVideo fallito, mando il link:', e.message);
      await bot.send(to, `${head}\n\n⚠️ Video non allegato (${esc((e.message || '').slice(0, 120))}). Scaricalo qui: ${it.video}`);
    }
    try { await bot.tg('sendPhoto', { chat_id: to, photo: it.cover, caption: `Copertina consigliata${it.coverNote ? ' (' + esc(it.coverNote) + ')' : ''}. Puoi anche sceglierla dalla timeline in Instagram.`, parse_mode: 'HTML' }); } catch (e) { warn('copertina:', e.message); }
    await bot.send(to, `📄 <b>Didascalia Instagram</b> — tocca per copiare\n${pre(igFull(it))}`);
    let extra = `🎵 <b>TikTok</b> (${esc(it.tiktokTime)}) — tocca per copiare\n${pre(it.tiktok)}`;
    if (it.alt) extra += `\n\n♿ <b>Testo alternativo</b> (Instagram → Impostazioni avanzate)\n${pre(it.alt)}`;
    if (it.english) extra += `\n\n🇬🇧 <i>Versione inglese, se la vuoi aggiungere:</i>\n${pre(it.english)}`;
    await bot.send(to, extra);
    await bot.send(to, `Quando l'hai pubblicato, segnalo qui sotto.${manual ? '' : '\n<i>Promemoria automatico: mancano 30 minuti allo slot.</i>'}`, { reply_markup: keyboard(it) });
    if (!manual) { state.sent[it.id] = Date.now(); saveState(); }
    log(`pacchetto inviato: reel ${it.id} (${it.title})`);
  } finally { busy = false; }
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

/* ── comandi ── */
function statusText() {
  const list = items();
  const rows = list.map(it => {
    const d = state.done[it.id] || {};
    const mark = d.instagram ? (d.tiktok ? '✅' : '📸') : (state.sent[it.id] ? '📤' : '•');
    return `${mark} ${it.date ? dateIt(it.date) : '—'} · reel ${it.reel} ${it.title}`;
  });
  const doneN = list.filter(it => isDone(it.id)).length;
  const skipped = plan().items.filter(i => i.skipped).map(i => `reel ${i.reel}`);
  return [
    `Calendario reel — ${doneN} su ${list.length} pubblicati${state.paused ? ' (IN PAUSA)' : ''}`,
    ...rows,
    skipped.length ? `Fuori calendario (già pubblicati a mano): ${skipped.join(', ')}` : '',
    '',
    'Legenda: • in attesa · 📤 inviato · 📸 su Instagram · ✅ anche su TikTok',
  ].filter(Boolean).join('\n');
}

const HELP = `Reel (Instagram e TikTok):
/reel — manda subito il prossimo pacchetto (anche: /reel 3)
/reels — calendario e stato
/pubblicato 3 — segna il reel 3 come pubblicato
/rimanda 3 — sposta il reel 3 di 3 giorni
/reelpausa e /reelriprendi — ferma o riattiva i promemoria`;

function findReel(arg) {
  const n = String(arg || '').replace(/[^0-9]/g, '');
  if (!n) return null;
  return items().find(it => it.reel === Number(n)) || plan().items.find(it => it.reel === Number(n)) || null;
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
    case 'reels': return send(esc(statusText()));
    case 'pubblicato': {
      const it = findReel(arg);
      if (!it) return send('Quale reel? Esempio: /pubblicato 3');
      state.done[it.id] = { ...(state.done[it.id] || {}), instagram: Date.now(), tiktok: (state.done[it.id] || {}).tiktok || null };
      saveState();
      const next = items().find(x => !isDone(x.id));
      return send(`✅ Reel ${it.reel} segnato come pubblicato su Instagram.${next ? `\nProssimo: reel ${next.reel} · ${esc(next.title)} — ${esc(dateIt(next.date))}.` : '\nEra l\'ultimo del calendario 🎉'}`);
    }
    case 'rimanda': {
      const it = findReel(arg);
      if (!it || !it.date) return send('Quale reel? Esempio: /rimanda 3');
      state.postponed[it.id] = addDays(it.date, 3);
      delete state.sent[it.id]; saveState();
      return send(`⏭ Reel ${it.reel} spostato a ${esc(dateIt(state.postponed[it.id]))}.`);
    }
    case 'reelpausa': state.paused = true; saveState(); return send('Promemoria dei reel in pausa. /reelriprendi per riattivarli.');
    case 'reelriprendi': state.paused = false; saveState(); return send('Promemoria dei reel riattivati.');
  }
}

async function onCallback(action, id, cb) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const it = plan().items.find(x => x.id === id);
  if (!it) return bot.send(chatId, 'Reel non trovato.');
  const d = state.done[it.id] || { instagram: null, tiktok: null };
  if (action === 'ig') {
    d.instagram = Date.now(); state.done[it.id] = d; saveState();
    const next = items().find(x => !isDone(x.id));
    return bot.send(chatId, `✅ Reel ${it.reel} pubblicato su Instagram. Alle ${esc(it.tiktokTime)} ti ricordo TikTok.${next ? `\nProssimo: reel ${next.reel} · ${esc(next.title)} — ${esc(dateIt(next.date))}.` : ''}`);
  }
  if (action === 'tt') {
    d.tiktok = Date.now(); if (!d.instagram) d.instagram = Date.now();
    state.done[it.id] = d; saveState();
    return bot.send(chatId, `🎵 Reel ${it.reel} segnato anche su TikTok. ${items().filter(x => !isDone(x.id)).length} reel ancora in calendario.`);
  }
  if (action === 'pp') {
    if (!it.date) return bot.send(chatId, 'Questo reel non è in calendario.');
    state.postponed[it.id] = addDays(state.postponed[it.id] || it.date, 3);
    delete state.sent[it.id]; saveState();
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

  bot.registerModule({
    name: 'social',
    commands: ['reel', 'reels', 'pubblicato', 'rimanda', 'reelpausa', 'reelriprendi'],
    prefixes: ['rl'],
    help: HELP,
    onCommand,
    onCallback,
  });

  app.get('/api/admin/reels', adminAuth, (req, res) => res.json({ status: statusText(), state }));
  app.post('/api/admin/reels/send/:id', adminAuth, async (req, res) => {
    const it = plan().items.find(x => x.id === String(req.params.id).padStart(2, '0'));
    if (!it) return res.status(404).json({ error: 'reel non trovato' });
    try { await sendPackage(it, null, { manual: true }); res.json({ ok: true, reel: it.reel }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  setInterval(() => { tick().catch(e => warn('tick:', e.message)); }, 5 * 60 * 1000);
  setTimeout(() => { tick().catch(e => warn('tick:', e.message)); }, 60 * 1000);
  const next = items().find(it => !isDone(it.id));
  log(`pronto: ${items().length} reel in calendario · prossimo ${next ? `reel ${next.reel} il ${dateIt(next.date)} (pacchetto alle ${sendHour()}:00)` : 'nessuno'}`);
}

module.exports = { init, statusText, sendPackage, _state: () => state };
