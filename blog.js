/* ════════════════════════════════════════════════
   BLOG AUTOMATICO — adrianolombardo.art/blog
   Ogni BLOG_INTERVAL_DAYS giorni (default 10) il server:
     1. sceglie un argomento da blog-topics.json non ancora usato
     2. scrive l'articolo con il modello LLM (llm.js, gratis con Gemini)
     3. genera la copertina con Gemini (modello immagine) oppure usa una foto del sito
     4. manda tutto ad Adriano su Telegram (foto + testo + anteprima con lo stile del sito)
     5. pubblica SOLO dopo "Pubblica": carica via FTP su Aruba l'articolo, le immagini,
        aggiorna blog/index.html e sitemap.xml, avvisa Bing & co. con IndexNow.
   Correzioni: Adriano risponde in chat con un testo → l'articolo viene riscritto.
   Variabili: TELEGRAM_BOT_TOKEN, ARUBA_FTP_USER, ARUBA_FTP_PASS (obbligatorie);
              TELEGRAM_OWNER_ID, TELEGRAM_WEBHOOK_SECRET, PUBLIC_URL, BLOG_INTERVAL_DAYS,
              BLOG_HOUR, GEMINI_IMAGE_MODEL, ARUBA_FTP_HOST, ARUBA_FTP_ROOT, ARUBA_FTP_SECURE,
              INDEXNOW_KEY, SITE_BASE, BLOG_MOCK=1 (senza LLM/immagini), BLOG_DRY_RUN=1 (niente FTP)
   ──────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const llm = require('./llm');

const env = (k, d = '') => (process.env[k] || d).trim();
const SITE = env('SITE_BASE', 'https://www.adrianolombardo.art').replace(/\/$/, '');
const HOST = SITE.replace(/^https?:\/\//, '');
const INDEXNOW_KEY = env('INDEXNOW_KEY', '9b5fcb6959d3decce1e807acf820a4c2');
const INTERVAL_DAYS = Math.max(1, Number(env('BLOG_INTERVAL_DAYS', '10')) || 10);
const SEND_HOUR = Math.min(23, Math.max(0, Number(env('BLOG_HOUR', '9')) || 9));
const TZ = 'Europe/Rome';
const TOPICS_FILE = path.join(__dirname, 'blog-topics.json');
const MOCK = env('BLOG_MOCK') === '1';
const DRY_RUN = env('BLOG_DRY_RUN') === '1';
const TOKEN = () => env('TELEGRAM_BOT_TOKEN');
const webhookSecret = () => env('TELEGRAM_WEBHOOK_SECRET') || crypto.createHash('sha256').update('hal-blog:' + TOKEN()).digest('hex').slice(0, 32);
const ftpConfigured = () => !!(env('ARUBA_FTP_USER') && env('ARUBA_FTP_PASS'));
const log = (...a) => console.log('[BLOG]', ...a);
const warn = (...a) => console.warn('[BLOG]', ...a);

let DATA_DIR = __dirname, STATE_FILE, WORK_DIR, publicUrl = '';
let state = null;
let busy = false;
let pollingAbort = null;

/* ── stato persistente ── */
function defaultState() {
  return { ownerChatId: env('TELEGRAM_OWNER_ID') ? Number(env('TELEGRAM_OWNER_ID')) : null, paused: false, nextRunAt: null, usedTopics: [], drafts: {}, published: [], lastReminderAt: null, lastError: null, pollOffset: 0, startedAt: Date.now() };
}
function loadState() {
  try { state = Object.assign(defaultState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch (e) { state = defaultState(); }
  if (env('TELEGRAM_OWNER_ID')) state.ownerChatId = Number(env('TELEGRAM_OWNER_ID'));
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { warn('salvataggio stato fallito:', e.message); }
}
function topics() {
  try { return JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8')); } catch (e) { return { topics: [], existing: [] }; }
}
function pendingDraft() { return Object.values(state.drafts).find(d => d.status === 'pending'); }
function draftsSorted() { return Object.values(state.drafts).sort((a, b) => b.createdAt - a.createdAt); }

/* ── date in Europa/Roma ── */
function romeParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute };
}
function romeOffsetMin(ms) { const r = romeParts(ms); return Math.round((Date.UTC(r.y, r.m - 1, r.d, r.h, r.min) - ms) / 60000); }
function atRome(y, m, d, h) { const guess = Date.UTC(y, m - 1, d, h); return guess - romeOffsetMin(guess) * 60000; }
function nextSlot(days) { const r = romeParts(Date.now() + days * 86400000); return atRome(r.y, r.m, r.d, SEND_HOUR); }
function todayIso() { const r = romeParts(Date.now()); return `${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}`; }
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
function dateIt(iso) { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MESI[m - 1]} ${y}`; }
function fmtWhen(ms) { if (!ms) return '-'; const r = romeParts(ms); return `${String(r.d).padStart(2, '0')}/${String(r.m).padStart(2, '0')}/${r.y} ${String(r.h).padStart(2, '0')}:${String(r.min).padStart(2, '0')}`; }

/* ── utilità testo ── */
const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', egrave: 'è', eacute: 'é', agrave: 'à', ograve: 'ò', ugrave: 'ù', igrave: 'ì', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', shy: '' };
function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') { const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); return isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[code] !== undefined ? ENT[code] : m;
  });
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72).replace(/-+$/, '');
}
function wordCount(html) { const t = stripTags(html); return t ? t.split(/\s+/).length : 0; }
function readingMinutes(html) { return Math.max(4, Math.round(wordCount(html) / 190)); }

/** Tiene solo i tag consentiti nel corpo dell'articolo */
function sanitizeBody(html) {
  let s = String(html || '');
  s = s.replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/?(html|head|body|article|main|section|div|span|header|footer|figure|figcaption|img|table|thead|tbody|tr|td|th|hr|h1|h4|h5|h6)\b[^>]*>/gi, (m) => /^<\/?h[1456]/i.test(m) ? (m[1] === '/' ? '</h3>' : '<h3>') : '');
  s = s.replace(/<(\/?)(p|h2|h3|ul|ol|li|strong|em|b|i|blockquote|br)\b[^>]*>/gi, (m, close, tag) => `<${close}${tag.toLowerCase()}>`);
  s = s.replace(/<a\b([^>]*)>/gi, (m, attrs) => {
    const h = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const href = h ? h[1].trim() : '';
    if (!/^(\/|https?:\/\/)/i.test(href)) return '';
    const ext = /^https?:\/\//i.test(href) && !href.startsWith(SITE);
    return `<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener"' : ''}>`;
  });
  s = s.replace(/<(?!\/?(p|h2|h3|ul|ol|li|strong|em|b|i|a|blockquote|br)\b)[^>]*>/gi, '');
  // link scartati: togli i </a> rimasti senza apertura
  { let depth = 0; s = s.replace(/<a\b[^>]*>|<\/a>/gi, (m) => { if (m[1] === '/') { if (depth <= 0) return ''; depth--; return m; } depth++; return m; }); }
  s = s.replace(/<p>\s*<\/p>/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

/** HTML dell'articolo → testo per Telegram (parse_mode HTML: solo b, i, a) */
function htmlToTelegram(html) {
  let s = String(html || '');
  s = s.replace(/<(strong|b)\b[^>]*>/gi, '\u0001B').replace(/<\/(strong|b)>/gi, '\u0001b');
  s = s.replace(/<(em|i)\b[^>]*>/gi, '\u0001I').replace(/<\/(em|i)>/gi, '\u0001i');
  s = s.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (m, t) => `\n\n\u0001B${decodeEntities(t.replace(/<[^>]+>/g, '')).toUpperCase()}\u0001b\n`);
  s = s.replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, (m, t) => `\n\u0001B${decodeEntities(t.replace(/<[^>]+>/g, ''))}\u0001b\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (m, t) => `• ${t.trim()}\n`);
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, t) => `\n\u0001I«${t.replace(/<[^>]+>/g, '').trim()}»\u0001i\n`);
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (m, t) => `${t.trim()}\n\n`);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\u0001B/g, '<b>').replace(/\u0001b/g, '</b>').replace(/\u0001I/g, '<i>').replace(/\u0001i/g, '</i>');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function splitMessage(text, max = 3800) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n\n/)) {
    const piece = para + '\n\n';
    if ((cur + piece).length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (piece.length > max) { for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max)); continue; }
    cur += piece;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/* ══════════════════════════════════════════════════
   1. TESTO — prompt e parsing
   ──────────────────────────────────────────────── */
const FORMATS = {
  guida: { label: 'guida pratica', rules: `FORMATO: GUIDA PRATICA. Intro di 2-3 paragrafi che entra subito nel merito, poi 4-7 sezioni con <h2> (eventuali <h3>), liste solo dove servono davvero, una <blockquote> con una frase forte tua verso la fine, chiusura pratica di 1-2 paragrafi (senza titolo "Conclusione"). Lunghezza 900-1300 parole.`, cta: { text: 'Hai un progetto, uno spazio o un evento in mente? Un brief di dieci minuti basta per una prima fascia di costo e di tempi.', label: 'Richiedi una stima' } },
  opera: { label: "racconto di un'opera", rules: `FORMATO: RACCONTO DI UN'OPERA. In prima persona: da dove nasce, cosa volevo che le persone sentissero, com'è fatta (materiali, luce, tecnologia, gesti del pubblico) senza cifre o date non fornite, cosa è successo con le persone, cosa ho capito dopo e cosa porto nella prossima opera. 3-5 sezioni con <h2> dai titoli brevi ed evocativi, pochissime liste, una <blockquote>. Tono caldo e concreto, immagini precise, niente gergo tecnico non necessario. Lunghezza 800-1100 parole.`, cta: { text: "Vuoi vedere le opere dal vivo, invitarle in uno spazio o parlarne per un progetto? Scrivimi.", label: 'Scrivimi' } },
  riflessione: { label: 'riflessione artistica', rules: `FORMATO: RIFLESSIONE. Saggio breve in prima persona su arte, luce, percezione, corpo, tempo: pensiero personale con esempi concreti dalle opere elencate, mai astratto per più di due frasi di fila. 3-5 sezioni con <h2> dai titoli brevi (anche una sola parola), niente elenchi puntati se non indispensabili, una <blockquote> con una frase tua. Nessuna promessa commerciale, nessun consiglio da manuale. Lunghezza 800-1100 parole.`, cta: { text: 'Se queste riflessioni ti parlano, scrivimi: per una mostra, una conversazione o una collaborazione.', label: 'Scrivimi' } },
  ricerca: { label: 'diario di ricerca', rules: `FORMATO: DIARIO DI RICERCA (Neuro.Flow e affini). La domanda di partenza, cosa ho provato (setup, persone, condizioni, in modo descrittivo), cosa ho osservato SENZA inventare numeri, percentuali o risultati scientifici, cosa non ha funzionato, cosa resta aperto e con chi vorrei lavorare. Tono onesto e curioso, 4-5 sezioni con <h2>, una <blockquote>. Distingui sempre ciò che è osservazione da ciò che è ipotesi. Lunghezza 800-1100 parole.`, cta: { text: 'Neuro.Flow è una ricerca aperta: se sei un laboratorio, un festival o un ricercatore, scrivimi.', label: 'Scrivimi' } },
  percorso: { label: 'racconto del percorso', rules: `FORMATO: PERCORSO PERSONALE. Racconto in prima persona di una parte del mio percorso: svolte, convinzioni, errori, scelte. USA SOLO i fatti biografici elencati sotto; non aggiungere date, età, scuole, premi, città, maestri o nomi non elencati; se serve un dettaglio che non hai, resta generico. 3-5 sezioni con <h2>, una <blockquote>, poche liste. Lunghezza 800-1100 parole.`, cta: { text: 'Vuoi parlare del mio lavoro per una mostra, una collaborazione o un progetto? Scrivimi.', label: 'Scrivimi' } },
};
const formatOf = (f) => FORMATS[f] ? f : 'guida';
const BIO = `Fatti biografici utilizzabili (SOLO questi): nato a Segrate, vicino a Milano, nel 1990; laureato in Scultura all'Accademia di Belle Arti di Brera con specializzazione in Arti Visive e installazioni interattive; vive e lavora a Milano; fa parte del collettivo Holy Club; ha esposto alla Biennale di Firenze, al Museo della Permanente di Milano, ad Art Dubai, alla Fabbrica del Vapore, al Bright Festival e al FRAC Museum di Baronissi; la sua ricerca esplora le connessioni invisibili tra essere umano, universo e tecnologia; riferimenti dichiarati: James Turrell, Olafur Eliasson, Anish Kapoor, Yayoi Kusama, Chiharu Shiota, Gianni Colombo.`;

function systemPrompt(format = 'guida') {
  const t = topics();
  const F = FORMATS[formatOf(format)];
  const existing = (t.existing || []).map(e => `- ${e.title} → ${SITE}${e.url}`).join('\n');
  return `Sei Adriano Lombardo e scrivi un articolo (${F.label}) per il blog del tuo sito ${SITE}/blog.
Chi sei: Creative Technologist e light designer, Milano. Progetti installazioni immersive e interattive, projection mapping, light design, arte generativa e opere che usano segnali EEG (onde cerebrali). Strumenti che usi davvero: TouchDesigner, NotchVFX, GrandMA3, Resolume, Three.js, sensori (LIDAR, telecamere di profondità), headset EEG consumer a pochi elettrodi.
${BIO}
Opere che puoi citare (solo queste, senza inventare dettagli): Neuro.Flow (ricerca aperta sulla sincronia cerebrale tra due persone: due headset EEG, Phase Locking Value, sfera proiettata e luce che reagiscono); Animus et Corpus (Bright Festival 2025, EEG → luce e proiezione); Interconnection (installazione immersiva di 600 m², Holy Club Gallery); The Cathedral (architettura di fili fluorescenti e luce UV); San Salvador (murales con fili fluorescenti e luce UV); Liquid Thoughts (grafica generativa, il pubblico partecipa dal telefono con un QR); Sailing Through Memories (partecipazione via web, memorie proiettate); Gods of the Digital Age (Opificio Innova); padiglione Dubai Municipality (proiezioni). Collaborazioni: Holy Club (holyclub.it), Sublime Tecnologico.

REGOLE FERREE
- Prima persona singolare, italiano naturale, tono diretto e concreto, da professionista che monta le installazioni, non da agenzia. Frasi brevi. Niente retorica, niente "in questo articolo", niente riassunti finali del tipo "in conclusione".
- NESSUN numero inventato: niente conteggi di installazioni, paesi, clienti, visitatori, premi, anni di esperienza, fatturato. Niente nomi di clienti o luoghi oltre a quelli elencati. Se serve un ordine di grandezza (costi, tempi, lumen, latenza) usa fasce ampie e chiaramente indicative.
- Niente promesse assolute, niente superlativi da marketing, niente emoji.
- ${F.rules}
- HTML consentito nel corpo: <p> <h2> <h3> <ul> <ol> <li> <strong> <em> <a> <blockquote>. Nessun <h1>, nessuna immagine, nessun <div>.
- Link interni consentiti (usane 2-3, solo se pertinenti, con testo ancora naturale): ${SITE}/contact.html, ${SITE}/works.html, ${SITE}/case-studies.html, ${SITE}/neuro-flow.html, ${SITE}/brands.html e gli articoli già pubblicati qui sotto. Nessun altro link.
- Il titolo (H1) è chiaro e specifico, 55-90 caratteri, senza clickbait, senza due punti doppi.
- Ortografia italiana curata anche nei titoli e nei campi brevi: apostrofi ed elisioni corretti (un'installazione, l'evento, dell'opera, quest'anno), accenti corretti (è, perché, più).

Articoli già pubblicati (non ripetere gli stessi contenuti; puoi linkarli):
${existing}

FORMATO DI RISPOSTA — esattamente queste sezioni, nell'ordine, senza altro testo prima o dopo, senza code fence:
###TITLE
il titolo H1
###META_TITLE
titolo per il tag <title>, massimo 60 caratteri, senza il nome dell'autore
###META_DESCRIPTION
140-160 caratteri, una frase utile a chi cerca su Google
###EXCERPT
1-2 frasi (max 220 caratteri) per la card nell'indice del blog
###SLUG
slug-in-minuscolo-con-trattini (4-8 parole chiave)
###KEYWORDS
5-7 parole chiave separate da virgola
###TAGS
3 tag brevi separati da virgola (es. Guida, Eventi, EEG)
###IMAGE_PROMPT
prompt in inglese (40-80 parole) per una fotografia di copertina: scena reale e concreta legata al tema, ambiente buio, luce ciano/teal e bianco, atmosfera cinematografica, nessun testo, nessun logo, nessun volto in primo piano
###IMAGE_ALT
testo alternativo in italiano della copertina (max 120 caratteri)
###BODY
il corpo dell'articolo in HTML
###END`;
}

function parseSections(text) {
  const out = {};
  const re = /^###([A-Z_]+)\s*$/gm;
  let m, last = null, lastIdx = 0;
  const src = String(text || '').replace(/\r/g, '');
  while ((m = re.exec(src))) {
    if (last) out[last] = src.slice(lastIdx, m.index).trim();
    last = m[1]; lastIdx = m.index + m[0].length;
  }
  if (last && last !== 'END') out[last] = src.slice(lastIdx).trim();
  return out;
}

function articleFromSections(sec, topic) {
  const need = ['TITLE', 'META_DESCRIPTION', 'BODY'];
  for (const k of need) if (!sec[k]) throw new Error(`risposta del modello senza sezione ${k}`);
  const body = sanitizeBody(sec.BODY);
  const words = wordCount(body);
  if (words < 450) throw new Error(`articolo troppo corto (${words} parole)`);
  const title = stripTags(sec.TITLE).replace(/^["«]|["»]$/g, '');
  let slug = slugify(sec.SLUG || title) || slugify(title);
  const taken = new Set([...(topics().existing || []).map(e => e.url.replace(/^\/blog\//, '').replace(/\.html$/, '')), ...state.published.map(p => p.slug)]);
  if (taken.has(slug)) { let i = 2; while (taken.has(`${slug}-${i}`)) i++; slug = `${slug}-${i}`; }
  const tags = (sec.TAGS || topic.tags.join(', ')).split(/[,;\n]/).map(s => stripTags(s)).filter(Boolean).slice(0, 4);
  // link all'articolo stesso (il modello a volte lo cita): tieni solo il testo
  const selfLink = new RegExp(`<a href="[^"]*/blog/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.html"[^>]*>([\\s\\S]*?)</a>`, 'gi');
  const cleanBody = body.replace(selfLink, '$1');
  return {
    title,
    metaTitle: (stripTags(sec.META_TITLE) || title).slice(0, 70),
    metaDescription: stripTags(sec.META_DESCRIPTION).slice(0, 170),
    excerpt: stripTags(sec.EXCERPT || sec.META_DESCRIPTION).slice(0, 240),
    slug,
    keywords: stripTags(sec.KEYWORDS || topic.keywords),
    tags: tags.length ? tags : topic.tags,
    imagePrompt: stripTags(sec.IMAGE_PROMPT || ''),
    imageAlt: stripTags(sec.IMAGE_ALT || topic.fallbackAlt || title).slice(0, 140),
    body: cleanBody,
    words,
    minutes: readingMinutes(cleanBody),
    format: formatOf(topic.format),
  };
}

async function writeArticle(topic, { feedback = [], previous = null } = {}) {
  if (MOCK) return mockArticle(topic);
  let user = `ARGOMENTO: ${topic.title}\nFORMATO: ${FORMATS[formatOf(topic.format)].label}\nTAGLIO: ${topic.angle}\nPAROLE CHIAVE SEO: ${topic.keywords}\nTAG SUGGERITI: ${topic.tags.join(', ')}\nDATA: ${dateIt(todayIso())}`;
  if (previous && feedback.length) {
    user += `\n\nQuesta è la versione precedente dell'articolo:\n###TITLE\n${previous.title}\n###BODY\n${previous.body}\n###END\n\nRISCRIVILO applicando queste correzioni di Adriano (hanno la priorità su tutto):\n${feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}\nMantieni ciò che non è toccato dalle correzioni. Rispondi con il formato completo delle sezioni.`;
  } else if (feedback.length) {
    user += `\n\nIndicazioni di Adriano da rispettare:\n${feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}`;
  }
  user += '\n\nScrivi ora l\'articolo nel formato richiesto.';
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, 20000 * (attempt - 1)));
    try {
      const r = await llm.complete({ system: systemPrompt(topic.format), messages: [{ role: 'user', content: user }], maxTokens: 7000, timeoutMs: 240000, json: true });
      const text = String(r.text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      const art = articleFromSections(parseSections(text), topic);
      art.model = `${r.provider}/${r.model}`;
      log(`articolo scritto da ${art.model}: "${art.title}" (${art.words} parole)`);
      return art;
    } catch (e) {
      lastErr = e; warn(`scrittura articolo, tentativo ${attempt} fallito:`, (e.message || '').slice(0, 300));
    }
  }
  throw lastErr;
}

function mockArticle(topic) {
  const body = sanitizeBody(`<p>Questo è un articolo di prova generato senza modello, per verificare la pipeline di pubblicazione dal server fino al sito. Il tema è: ${esc(topic.title)}.</p>
<h2>Prima sezione</h2><p>${'Testo di prova che riempie il paragrafo con parole sufficienti per contare come contenuto reale. '.repeat(12)}</p>
<h2>Seconda sezione</h2><ul><li><strong>Punto uno.</strong> Dettaglio del punto uno.</li><li><strong>Punto due.</strong> Dettaglio del punto due.</li></ul><p>${'Altro testo di prova per la seconda sezione, con una frase che va a capo e continua. '.repeat(12)}</p>
<h2>Terza sezione</h2><p>${'Ultimo blocco di testo di prova per raggiungere una lunghezza credibile. '.repeat(12)}</p>
<blockquote>Una frase forte, ma di prova.</blockquote>
<p>Per una stima concreta scrivimi dalla <a href="${SITE}/contact.html">pagina contatti</a>.</p>`);
  return { title: `${topic.title} (prova)`, metaTitle: topic.title.slice(0, 60), metaDescription: `Articolo di prova sul tema: ${topic.title}.`.slice(0, 160), excerpt: `Articolo di prova sul tema ${topic.title}.`, slug: slugify('prova-' + topic.id + '-' + Date.now().toString(36)), keywords: topic.keywords, tags: topic.tags, imagePrompt: 'test', imageAlt: topic.fallbackAlt, body, words: wordCount(body), minutes: readingMinutes(body), format: formatOf(topic.format), model: 'mock' };
}

/* ══════════════════════════════════════════════════
   2. IMMAGINE — Gemini (generateContent con IMAGE) oppure foto del sito
   ──────────────────────────────────────────────── */
let imageModelCache = { at: 0, models: [] };
async function imageModels(key) {
  const forced = env('GEMINI_IMAGE_MODEL');
  if (Date.now() - imageModelCache.at < 3600 * 1000 && imageModelCache.models.length) return forced ? [forced, ...imageModelCache.models.filter(m => m !== forced)] : imageModelCache.models;
  let found = [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    found = (j.models || []).filter(m => /image/i.test(m.name) && !/imagen|embedding|veo/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
    const ver = (n) => { const m = /(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };
    found.sort((a, b) => (ver(b) - ver(a)) || ((/preview/i.test(a) ? 1 : 0) - (/preview/i.test(b) ? 1 : 0)) || ((/flash/i.test(b) ? 1 : 0) - (/flash/i.test(a) ? 1 : 0)));
  } catch (e) { warn('lista modelli immagine non letta:', e.message); }
  if (!found.length) found = ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'];
  imageModelCache = { at: Date.now(), models: found };
  log('modelli immagine disponibili:', found.join(', '));
  return forced ? [forced, ...found.filter(m => m !== forced)] : found;
}

const badImageModel = {}; // modello → true (inesistente) | timestamp fine pausa (quota)
async function geminiImage(prompt) {
  const key = env('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY assente');
  const fullPrompt = `${prompt}. Photorealistic editorial photograph, 16:9, dark environment, cyan and teal light with soft white highlights, cinematic contrast, shallow depth of field, high detail. No text, no letters, no watermark, no logo, no recognizable faces.`;
  const errors = [];
  for (const model of await imageModels(key)) {
    const bad = badImageModel[model];
    if (bad === true || (typeof bad === 'number' && bad > Date.now())) continue;
    for (const withRatio of [true, false]) {
      const body = { contents: [{ parts: [{ text: fullPrompt }] }], generationConfig: { responseModalities: ['IMAGE'] } };
      if (withRatio) body.generationConfig.imageConfig = { aspectRatio: '16:9' };
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(150000) });
      } catch (e) { errors.push(`${model}: ${e.message}`); warn(`immagine ${model}: ${e.message}`); break; }
      if (!r.ok) {
        const t = (await r.text().catch(() => '')).replace(/\s+/g, ' ');
        let msg = t; try { msg = JSON.parse(t).error?.message || t; } catch (e) {}
        errors.push(`${model}: ${r.status} ${msg.slice(0, 120)}`);
        warn(`immagine ${model}: ${r.status} ${msg.slice(0, 400)}`);
        if (r.status === 400 && withRatio && /imageConfig|aspect/i.test(t)) continue; // riprova senza rapporto
        if (r.status === 404 || (r.status === 400 && /not found|not supported|unsupported|does not exist/i.test(msg))) badImageModel[model] = true;
        else if (r.status === 429) badImageModel[model] = Date.now() + (/limit(_value)?:\s*0\b|limit of 0\b/i.test(t) ? 24 * 3600 * 1000 : 10 * 60 * 1000);
        else if (r.status >= 500) badImageModel[model] = Date.now() + 2 * 60 * 1000;
        break; // altro modello
      }
      const j = await r.json();
      const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      const img = parts.find(p => p.inlineData && p.inlineData.data);
      if (!img) { errors.push(`${model}: risposta senza immagine`); break; }
      log(`copertina generata con ${model} (${img.inlineData.mimeType})`);
      return { buffer: Buffer.from(img.inlineData.data, 'base64'), mime: img.inlineData.mimeType || 'image/png', model };
    }
  }
  throw new Error('immagine non generata: ' + errors.join(' | ').slice(0, 500));
}

const STYLE = 'Photorealistic editorial photograph, dark environment, cyan and teal light with soft white highlights, cinematic contrast, shallow depth of field, high detail. People, if any, only as distant silhouettes seen from behind. No text, no letters, no watermark, no logo, no faces.';
function looksLikeImage(buf, mime) {
  if (!buf || buf.length < 15000) return false;
  const h = buf.slice(0, 4).toString('hex');
  return h.startsWith('ffd8') || h === '89504e47' || h.startsWith('52494646') || /^image\//i.test(mime || '');
}
/** Hugging Face Inference (FLUX.1-schnell): gratis con HF_TOKEN da huggingface.co/settings/tokens */
async function hfImage(prompt) {
  const token = env('HF_TOKEN');
  if (!token) throw new Error('HF_TOKEN assente');
  const model = env('HF_IMAGE_MODEL', 'black-forest-labs/FLUX.1-schnell');
  const r = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'image/*' },
    body: JSON.stringify({ inputs: `${prompt}. ${STYLE}`, parameters: { width: 1600, height: 896, num_inference_steps: 4 } }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) throw new Error(`HF ${model}: ${r.status} ${(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!looksLikeImage(buf, r.headers.get('content-type'))) throw new Error('HF: risposta non è un\'immagine');
  return { buffer: buf, mime: r.headers.get('content-type') || 'image/jpeg', model: 'huggingface/' + model };
}
/** Pollinations (image.pollinations.ai): gratis, senza chiave, modello flux */
async function pollinationsImage(prompt) {
  const model = env('POLLINATIONS_MODEL', 'flux');
  const seed = Math.floor(Math.random() * 1e6);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(`${prompt}. ${STYLE}`)}?width=1600&height=900&nologo=true&model=${encodeURIComponent(model)}&seed=${seed}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`Pollinations: ${r.status} ${(await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!looksLikeImage(buf, r.headers.get('content-type'))) throw new Error('Pollinations: risposta non è un\'immagine');
  return { buffer: buf, mime: r.headers.get('content-type') || 'image/jpeg', model: 'pollinations/' + model };
}

async function buildImageSet(buffer, slug) {
  const dir = path.join(WORK_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) { warn('sharp non disponibile, uso l\'immagine grezza:', e.message); }
  if (sharp) {
    const base = sharp(buffer).rotate();
    const out = async (name, pipeline) => { const local = path.join(dir, name); await pipeline.toFile(local); files.push({ local, remote: `img/blog/${name}` }); };
    await out(`${slug}.jpg`, base.clone().resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }));
    await out(`${slug}-1024.webp`, base.clone().resize({ width: 1024, withoutEnlargement: true }).webp({ quality: 78 }));
    await out(`${slug}-480.webp`, base.clone().resize({ width: 480, withoutEnlargement: true }).webp({ quality: 75 }));
    await out(`${slug}-og.jpg`, base.clone().resize({ width: 1200, height: 630, fit: 'cover' }).jpeg({ quality: 82, mozjpeg: true }));
    return { src: `/img/blog/${slug}.jpg`, srcset: `/img/blog/${slug}-480.webp 480w, /img/blog/${slug}-1024.webp 1024w`, og: `/img/blog/${slug}-og.jpg`, files, preview: files[0].local };
  }
  const ext = /png/i.test(String(buffer.slice(0, 8).toString('hex'))) ? 'png' : 'jpg';
  const local = path.join(dir, `${slug}.${ext}`);
  fs.writeFileSync(local, buffer);
  files.push({ local, remote: `img/blog/${slug}.${ext}` });
  return { src: `/img/blog/${slug}.${ext}`, srcset: '', og: `/img/blog/${slug}.${ext}`, files, preview: local };
}

async function makeCover(article, topic) {
  if (!MOCK && topic.cover !== 'site') {
    const prompt = article.imagePrompt || topic.title;
    const providers = [];
    const order = env('BLOG_IMAGE_PROVIDERS', 'gemini,huggingface,pollinations').split(',').map(x => x.trim().toLowerCase());
    for (const name of order) {
      if (name === 'gemini' && env('GEMINI_API_KEY')) providers.push(['Gemini', () => geminiImage(prompt)]);
      if (name === 'huggingface' && env('HF_TOKEN')) providers.push(['Hugging Face', () => hfImage(prompt)]);
      if (name === 'pollinations') providers.push(['Pollinations', () => pollinationsImage(prompt)]);
    }
    for (const [label, fn] of providers) {
      try {
        const g = await fn();
        const set = await buildImageSet(g.buffer, article.slug);
        log(`copertina generata con ${g.model} (${g.buffer.length} byte)`);
        return Object.assign(set, { kind: 'gemini', model: g.model, alt: article.imageAlt });
      } catch (e) { warn(`copertina ${label} fallita:`, (e.message || '').slice(0, 300)); state.lastError = 'immagine: ' + (e.message || '').slice(0, 200); }
    }
    warn('nessun generatore di immagini disponibile, uso una foto del sito');
  }
  const src = topic.fallback || '/img/interconnection/1.jpg';
  const b = src.replace(/\.jpg$/, '');
  if (topic.cover === 'site') log(`copertina: foto dell'opera ${src} (argomento legato a un'opera reale)`);
  return { kind: 'fallback', src, srcset: `${b}-480.webp 480w, ${b}-1024.webp 1024w`, og: topic.fallbackOg || `${b}-og.jpg`, files: [], preview: null, alt: topic.fallbackAlt || article.imageAlt, model: topic.cover === 'site' ? "foto dell'opera" : 'foto del sito' };
}

/* ══════════════════════════════════════════════════
   3. HTML — pagina articolo, card indice, sitemap
   ──────────────────────────────────────────────── */
const NAV = `<header class="sn">
  <a class="sn-logo" href="/">Adriano Lombardo</a>
  <nav class="sn-links" aria-label="Principale">
    <a href="/">Home</a><a href="/works.html">Works</a><a href="/case-studies.html">Case Studies</a>
    <a href="/network.html">Network</a><a href="/brands.html">Brands</a><a href="/neuro-flow.html">Neuro.Flow</a>
    <a href="/lab.html">Lab</a><a href="/about.html">About</a><a href="/contact.html">Contact</a>
  </nav>
  <div class="sn-right"><a class="sn-lang" href="/en/" hreflang="en" lang="en">EN</a>
    <button class="sn-burger" type="button" aria-label="Menu" aria-expanded="false"><span></span><span></span></button></div>
</header>
<script>document.querySelector('.sn-burger').addEventListener('click',function(){var o=document.body.classList.toggle('sn-open');this.setAttribute('aria-expanded',o)})</script>`;
const FOOTER = `<footer class="sf">
  <div class="sf-row"><span class="sf-copy">© ${new Date().getFullYear()} Adriano Lombardo · P.IVA IT04360230165</span>
    <nav class="sf-links" aria-label="Legale"><a href="/privacy-policy.html">Privacy</a><a href="/cookie-policy.html">Cookie</a><a href="/condizioni-uso.html">Condizioni d'uso</a>
      <a href="https://holyclub.it" target="_blank" rel="noopener">Holy Club ↗</a><a href="https://www.sublimetecnologico.com" target="_blank" rel="noopener">Sublime Tecnologico ↗</a></nav></div>
</footer>`;
const PARTICLES = `<canvas id="bg-p" aria-hidden="true"></canvas>
<script>
(function(){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  var c=document.getElementById('bg-p'),x=c.getContext('2d'),w,h,p=[],mx=-9999,my=-9999;
  var LINK=120,N=90,mob=innerWidth<=768;
  if(mob){LINK=90;N=50;}
  function rs(){w=c.width=innerWidth;h=c.height=innerHeight}
  rs();addEventListener('resize',rs);
  addEventListener('mousemove',function(e){mx=e.clientX;my=e.clientY});
  addEventListener('mouseleave',function(){mx=-9999;my=-9999});
  for(var i=0;i<N;i++)p.push({x:Math.random()*2e3,y:Math.random()*2e3,r:Math.random()*1.5+.5,vx:(Math.random()-.5)*.25,vy:(Math.random()-.5)*.25,a:Math.random()*.3+.08});
  (function d(){
    x.clearRect(0,0,w,h);
    var i,j,q,q2,dx,dy,ds;
    for(i=0;i<p.length;i++){q=p[i];dx=q.x-mx;dy=q.y-my;ds=dx*dx+dy*dy;if(ds<12000&&ds>1){var f=.8/Math.sqrt(ds);q.vx+=dx*f*.06;q.vy+=dy*f*.06}q.x+=q.vx;q.y+=q.vy;q.vx*=.998;q.vy*=.998;if(q.x<-10)q.x=w+10;if(q.x>w+10)q.x=-10;if(q.y<-10)q.y=h+10;if(q.y>h+10)q.y=-10;}
    for(i=0;i<p.length;i++){q=p[i];for(j=i+1;j<p.length;j++){q2=p[j];dx=q.x-q2.x;dy=q.y-q2.y;ds=dx*dx+dy*dy;if(ds<LINK*LINK){var a=1-Math.sqrt(ds)/LINK;x.beginPath();x.moveTo(q.x,q.y);x.lineTo(q2.x,q2.y);x.strokeStyle='rgba(255,255,255,'+(a*.12).toFixed(3)+')';x.lineWidth=.5;x.stroke();}}}
    for(i=0;i<p.length;i++){q=p[i];x.beginPath();x.arc(q.x,q.y,q.r,0,6.283);x.fillStyle='rgba(255,255,255,'+q.a+')';x.fill();}
    requestAnimationFrame(d);
  })();
})();
</script>`;

function renderArticle(a, img, date, { preview = false } = {}) {
  const url = `${SITE}/blog/${a.slug}.html`;
  const ogImg = SITE + img.og;
  const ld = {
    '@context': 'https://schema.org', '@type': 'Article', headline: a.title, description: a.metaDescription, image: ogImg,
    datePublished: date, dateModified: date, inLanguage: 'it',
    author: { '@type': 'Person', name: 'Adriano Lombardo', url: SITE, '@id': `${SITE}/#adriano-lombardo` },
    publisher: { '@type': 'Person', name: 'Adriano Lombardo', url: SITE },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url }, keywords: a.keywords,
  };
  const tags = a.tags.map(t => `    <span class="sn-link tag">${esc(t)}</span>`).join('\n');
  return `<!DOCTYPE html>
<html lang="it">
<head>
${preview ? `<base href="${SITE}/">\n<meta name="robots" content="noindex, nofollow">` : `<!-- Google tag (gtag.js) GA4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-BDPDZE418C"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-BDPDZE418C');
</script>`}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(a.metaTitle)} | Adriano Lombardo</title>
<meta name="description" content="${esc(a.metaDescription)}">
<meta name="keywords" content="${esc(a.keywords)}">
<meta name="author" content="Adriano Lombardo">
${preview ? '' : '<meta name="robots" content="index, follow">'}
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:description" content="${esc(a.metaDescription)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${ogImg}">
<meta property="og:locale" content="it_IT">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(a.title)}">
<meta name="twitter:description" content="${esc(a.metaDescription)}">
<meta name="twitter:image" content="${ogImg}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#000000">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/img/apple-touch-icon.png">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Space+Grotesk:wght@300;400;500&display=swap" rel="stylesheet">
<script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
</script>
<link rel="stylesheet" href="/css/site.css?v=5">
<style>
/* stili locali: solo layout; colori, font e componenti vengono da /css/site.css */
/* colonna di lettura centrata anche su schermi larghi */
main.sn-wrap{max-width:calc(var(--measure) + 2*var(--sp-page))}
.sn-hero{max-width:var(--measure)}
.sn-hero .article-meta{display:flex;flex-wrap:wrap;gap:.6rem 1.4rem;align-items:center;margin:1.4rem 0 0}
.article-meta .tag{border:1px solid var(--g3);padding:.25rem .55rem;font-size:.55rem}
.article-cover{max-width:var(--measure);margin:2rem 0 2.4rem}
.article-cover img{display:block;width:100%;height:auto;border:1px solid var(--gfine)}
.article-body p{color:var(--white)}
.article-cta{max-width:var(--measure);margin-top:var(--sp-section);border:1px solid var(--gfine);padding:2rem;text-align:center}
.article-cta p{margin:0 auto 1.4rem;color:var(--gtxt)}
#bg-p{position:fixed;inset:0;z-index:-1;pointer-events:none}
${preview ? '.preview-note{position:fixed;bottom:0;left:0;right:0;z-index:10000;background:#0af5f5;color:#000;font:600 .7rem/1.4 "Space Grotesk",sans-serif;letter-spacing:.08em;text-transform:uppercase;text-align:center;padding:.4rem .8rem}' : ''}
</style>
</head>
<body>
${preview ? '<div class="preview-note">Anteprima — non ancora pubblicato</div>' : ''}
${NAV}

<main class="sn-wrap">
<nav class="sn-crumb" aria-label="Percorso"><a href="/">Home</a><span>/</span><a href="/blog/">Blog</a><span>/</span><b>${esc(a.title.length > 60 ? a.title.slice(0, 57).replace(/\s+\S*$/, '') + '…' : a.title)}</b></nav>
<article>
  <header class="sn-hero">
    <h1>${esc(a.title)}</h1>
    <div class="sn-label article-meta">
    <span>${esc(dateIt(date))}</span>
    <span>${a.minutes} min lettura</span>
${tags}
    </div>
  </header>

  <figure class="article-cover"><img src="${img.src}"${img.srcset ? ` srcset="${img.srcset}" sizes="(max-width:768px) 100vw, 760px"` : ''} alt="${esc(img.alt)}" width="1600" height="900" decoding="async"></figure>

  <div class="sn-prose article-body">
${a.body}
  </div>

  <div class="article-cta">
    <p>${esc(FORMATS[formatOf(a.format)].cta.text)}</p>
    <a href="/contact.html" class="sn-cta">${esc(FORMATS[formatOf(a.format)].cta.label)}</a>
  </div>
</article>
</main>

${FOOTER}

${PARTICLES}
</body>
</html>
`;
}

function renderCard(a, img, date) {
  return `  <a class="sn-card post" href="/blog/${a.slug}.html">
    <div class="sn-card-media"><img src="${img.src}"${img.srcset ? ` srcset="${img.srcset}"` : ''} sizes="(max-width:768px) 100vw, 460px" alt="${esc(img.alt)}" loading="lazy" decoding="async"></div>
    <div class="sn-card-body">
      <div class="sn-label meta"><span>${esc(dateIt(date))}</span><span>${a.minutes} min</span></div>
      <h2>${esc(a.title)}</h2>
      <p>${esc(a.excerpt)}</p>
      <div class="tags">${a.tags.map(t => `<span class="sn-link tag">${esc(t)}</span>`).join('')}</div>
      <span class="sn-link more">Leggi →</span>
    </div>
  </a>`;
}
function feedEntry(a, img, date) {
  return { slug: a.slug, url: `/blog/${a.slug}.html`, title: a.title, excerpt: a.excerpt, date, dateLabel: dateIt(date), minutes: a.minutes, tags: a.tags, image: { src: img.src, srcset: img.srcset || '', alt: img.alt || '' } };
}
function updateFeed(jsonText, entry, date) {
  let feed = { updated: date, posts: [] };
  try { const j = JSON.parse(jsonText || ''); if (j && Array.isArray(j.posts)) feed = j; } catch (e) {}
  feed.posts = [entry].concat((feed.posts || []).filter(p => p && p.slug !== entry.slug));
  feed.updated = date;
  return JSON.stringify(feed, null, 2) + '\n';
}
function insertCard(indexHtml, card, slug) {
  if (indexHtml.includes(`href="/blog/${slug}.html"`)) return indexHtml;
  const i = indexHtml.indexOf('<a class="sn-card post"');
  if (i < 0) throw new Error('blog/index.html: nessuna card trovata, struttura cambiata');
  const nl = indexHtml.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = indexHtml.lastIndexOf('\n', i) + 1;
  return indexHtml.slice(0, lineStart) + card.replace(/\n/g, nl) + nl + nl + indexHtml.slice(lineStart);
}
function updateSitemap(xml, url, date) {
  const nl = xml.includes('\r\n') ? '\r\n' : '\n';
  const entry = `  <url>${nl}    <loc>${url}</loc>${nl}    <lastmod>${date}</lastmod>${nl}    <changefreq>monthly</changefreq>${nl}    <priority>0.7</priority>${nl}  </url>${nl}`;
  let out = xml;
  if (out.includes(`<loc>${url}</loc>`)) {
    out = out.replace(new RegExp(`(<loc>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</loc>\\s*<lastmod>)[^<]*`), `$1${date}`);
  } else {
    const blogLoc = out.indexOf(`<loc>${SITE}/blog/</loc>`);
    const after = blogLoc >= 0 ? out.indexOf('</url>', blogLoc) : -1;
    if (after >= 0) { const cut = after + '</url>'.length; out = out.slice(0, cut) + nl + entry.slice(0, -nl.length) + out.slice(cut); }
    else out = out.replace('</urlset>', entry + '</urlset>');
  }
  // lastmod dell'indice del blog
  out = out.replace(new RegExp(`(<loc>${SITE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/blog/</loc>\\s*<lastmod>)[^<]*`), `$1${date}`);
  return out;
}

/* ══════════════════════════════════════════════════
   4. PUBBLICAZIONE — FTP Aruba + IndexNow
   ──────────────────────────────────────────────── */
async function withFtp(fn) {
  const ftp = require('basic-ftp');
  const client = new ftp.Client(45000);
  client.ftp.verbose = false;
  try {
    await client.access({ host: env('ARUBA_FTP_HOST', 'ftp.adrianolombardo.art'), user: env('ARUBA_FTP_USER'), password: env('ARUBA_FTP_PASS'), secure: env('ARUBA_FTP_SECURE') === '1', secureOptions: { rejectUnauthorized: false } });
    return await fn(client);
  } finally { client.close(); }
}
const remoteRoot = () => env('ARUBA_FTP_ROOT', '/www.adrianolombardo.art').replace(/\/$/, '');
async function ftpDownloadText(client, remote) {
  const tmp = path.join(WORK_DIR, 'dl-' + crypto.randomBytes(4).toString('hex'));
  await client.downloadTo(tmp, remote);
  const t = fs.readFileSync(tmp, 'utf8'); fs.unlinkSync(tmp); return t;
}
async function ftpUploadText(client, remote, text) {
  const tmp = path.join(WORK_DIR, 'ul-' + crypto.randomBytes(4).toString('hex'));
  fs.writeFileSync(tmp, text); await client.uploadFrom(tmp, remote); fs.unlinkSync(tmp);
}

async function indexNow(urls) {
  try {
    const r = await fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host: HOST, key: INDEXNOW_KEY, keyLocation: `${SITE}/${INDEXNOW_KEY}.txt`, urlList: urls }), signal: AbortSignal.timeout(15000) });
    log('IndexNow', r.status);
    return r.status;
  } catch (e) { warn('IndexNow fallito:', e.message); return 0; }
}

async function publish(draft) {
  if (!DRY_RUN && !ftpConfigured()) throw new Error('FTP non configurato: servono ARUBA_FTP_USER e ARUBA_FTP_PASS');
  const a = draft.article, img = draft.image;
  const date = todayIso();
  const html = renderArticle(a, img, date);
  const card = renderCard(a, img, date);
  const url = `${SITE}/blog/${a.slug}.html`;
  fs.mkdirSync(path.join(WORK_DIR, a.slug), { recursive: true });
  fs.writeFileSync(path.join(WORK_DIR, a.slug, 'article.html'), html);
  if (DRY_RUN) {
    const siteDir = env('SITE_LOCAL_DIR', path.join(__dirname, '..'));
    const outDir = path.join(WORK_DIR, 'dry-run'); fs.mkdirSync(path.join(outDir, 'blog'), { recursive: true }); fs.mkdirSync(path.join(outDir, 'img', 'blog'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'blog', `${a.slug}.html`), html);
    for (const f of img.files) fs.copyFileSync(f.local, path.join(outDir, f.remote));
    const idx = fs.readFileSync(path.join(siteDir, 'blog', 'index.html'), 'utf8');
    fs.writeFileSync(path.join(outDir, 'blog', 'index.html'), insertCard(idx, card, a.slug));
    const sm = fs.readFileSync(path.join(siteDir, 'sitemap.xml'), 'utf8');
    fs.writeFileSync(path.join(outDir, 'sitemap.xml'), updateSitemap(sm, url, date));
    let feedText = ''; try { feedText = fs.readFileSync(path.join(siteDir, 'blog', 'posts.json'), 'utf8'); } catch (e) {}
    fs.writeFileSync(path.join(outDir, 'blog', 'posts.json'), updateFeed(feedText, feedEntry(a, img, date), date));
    log('DRY RUN: file scritti in', outDir);
  } else {
    await withFtp(async (client) => {
      const root = remoteRoot();
      if (img.files.length) { await client.ensureDir(`${root}/img/blog`); await client.cd('/'); }
      for (const f of img.files) { await client.uploadFrom(f.local, `${root}/${f.remote}`); log('caricato', f.remote); }
      await ftpUploadText(client, `${root}/blog/${a.slug}.html`, html); log('caricato blog/' + a.slug + '.html');
      const idx = await ftpDownloadText(client, `${root}/blog/index.html`);
      await ftpUploadText(client, `${root}/blog/index.html`, insertCard(idx, card, a.slug)); log('aggiornato blog/index.html');
      const sm = await ftpDownloadText(client, `${root}/sitemap.xml`);
      await ftpUploadText(client, `${root}/sitemap.xml`, updateSitemap(sm, url, date)); log('aggiornato sitemap.xml');
      let feedText = '';
      try { feedText = await ftpDownloadText(client, `${root}/blog/posts.json`); } catch (e) { warn('blog/posts.json non trovato sul server, lo creo'); }
      await ftpUploadText(client, `${root}/blog/posts.json`, updateFeed(feedText, feedEntry(a, img, date), date)); log('aggiornato blog/posts.json (feed della SPA)');
    });
    await indexNow([url, `${SITE}/blog/`]);
  }
  draft.status = 'published'; draft.publishedAt = Date.now(); draft.url = url; draft.date = date;
  if (!state.usedTopics.includes(draft.topicId)) state.usedTopics.push(draft.topicId);
  state.published.push({ slug: a.slug, title: a.title, url, date, topicId: draft.topicId, image: img.kind });
  saveState();
  return url;
}

/* ══════════════════════════════════════════════════
   5. TELEGRAM
   ──────────────────────────────────────────────── */
async function tg(method, payload = {}, files = null) {
  if (!TOKEN()) throw new Error('TELEGRAM_BOT_TOKEN assente');
  const url = `https://api.telegram.org/bot${TOKEN()}/${method}`;
  let res;
  if (files) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(payload)) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([fs.readFileSync(f.path)], { type: f.type || 'application/octet-stream' }), f.name || path.basename(f.path));
    res = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  } else {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 30000) });
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status}`);
  return j.result;
}
async function send(chatId, text, extra = {}) {
  try { return await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch (e) {
    if (/parse|entit|tag/i.test(e.message)) return tg('sendMessage', { chat_id: chatId, text: text.replace(/<[^>]+>/g, ''), disable_web_page_preview: true, ...extra });
    throw e;
  }
}
const owner = () => state.ownerChatId;
async function notifyOwner(text, extra) { if (owner()) { try { return await send(owner(), text, extra); } catch (e) { warn('invio Telegram fallito:', e.message); } } }

function keyboard(draft) {
  return { inline_keyboard: [
    [{ text: '✅ Pubblica sul sito', callback_data: `pub:${draft.id}` }],
    [{ text: '🔁 Riscrivi', callback_data: `regen:${draft.id}` }, { text: '🖼 Nuova immagine', callback_data: `img:${draft.id}` }],
    [{ text: '❌ Scarta', callback_data: `rej:${draft.id}` }],
  ] };
}

async function sendDraft(draft, { onlyImage = false } = {}) {
  const a = draft.article, img = draft.image;
  const previewUrl = publicUrl ? `${publicUrl}/api/blog/preview/${draft.id}` : '';
  const caption = `📝 <b>Articolo proposto per il blog</b>\n\n<b>${esc(a.title)}</b>\n${esc(a.excerpt)}\n\n✍️ ${esc(FORMATS[formatOf(a.format)].label)} · ⏱ ${a.minutes} min · ${a.words} parole · 🏷 ${esc(a.tags.join(', '))}\n🖼 Copertina: ${esc(img.kind === 'gemini' ? 'generata con ' + img.model : img.model + ' (' + img.src + ')')}\n🤖 Testo: ${esc(a.model || '-')}${previewUrl ? `\n\n🔗 <a href="${previewUrl}">Anteprima con lo stile del sito</a>` : ''}`;
  let m;
  if (img.preview && fs.existsSync(img.preview)) m = await tg('sendPhoto', { chat_id: owner(), caption, parse_mode: 'HTML' }, { photo: { path: img.preview, type: 'image/jpeg', name: 'cover.jpg' } });
  else m = await tg('sendPhoto', { chat_id: owner(), photo: SITE + img.src, caption, parse_mode: 'HTML' }).catch(() => send(owner(), caption));
  draft.messageIds = [m && m.message_id].filter(Boolean);
  if (!onlyImage) for (const chunk of splitMessage(htmlToTelegram(a.body))) { const r = await send(owner(), chunk); if (r) draft.messageIds.push(r.message_id); }
  const r = await send(owner(), `Cosa faccio con «${esc(a.title)}»?\n\n<i>Per una correzione, rispondi qui con un messaggio (es. «accorcia l'intro e togli la parte sui costi»): riscrivo e ti rimando l'articolo.</i>`, { reply_markup: keyboard(draft) });
  if (r) draft.messageIds.push(r.message_id);
  saveState();
}

/* ══════════════════════════════════════════════════
   6. CICLO: crea bozza → invia → gestisci risposte
   ──────────────────────────────────────────────── */
function pickTopic(topicId) {
  const all = topics().topics;
  if (topicId) { const t = all.find(x => x.id === topicId); if (!t) throw new Error(`argomento "${topicId}" non trovato`); return t; }
  const inDrafts = new Set(Object.values(state.drafts).filter(d => d.status === 'pending').map(d => d.topicId));
  const free = all.filter(t => !state.usedTopics.includes(t.id) && !inDrafts.has(t.id));
  if (!free.length) throw new Error('argomenti esauriti: aggiungine a blog-topics.json');
  // alterna i formati: guida → opera → riflessione → ricerca → percorso → guida …
  const cycle = ['guida', 'opera', 'riflessione', 'ricerca', 'percorso'];
  const lastId = state.usedTopics[state.usedTopics.length - 1];
  const last = all.find(t => t.id === lastId);
  const start = last ? (cycle.indexOf(formatOf(last.format)) + 1) % cycle.length : 0;
  for (let i = 0; i < cycle.length; i++) {
    const f = cycle[(start + i) % cycle.length];
    const hit = free.find(t => formatOf(t.format) === f);
    if (hit) return hit;
  }
  return free[0];
}

async function createDraft({ topicId = null, feedback = [], previous = null, keepImage = null } = {}) {
  if (busy) throw new Error('operazione già in corso, riprova tra un minuto');
  busy = true;
  try {
    const topic = pickTopic(topicId);
    const article = await writeArticle(topic, { feedback, previous });
    const image = keepImage && keepImage.kind ? keepImage : await makeCover(article, topic);
    const draft = { id: crypto.randomBytes(8).toString('hex'), topicId: topic.id, status: 'pending', createdAt: Date.now(), article, image, feedback: feedback.slice(), messageIds: [], version: previous ? (previous.version || 1) + 1 : 1 };
    for (const d of Object.values(state.drafts)) if (d.status === 'pending') d.status = 'superseded';
    state.drafts[draft.id] = draft;
    // tieni solo le ultime 20 bozze
    for (const d of draftsSorted().slice(20)) delete state.drafts[d.id];
    state.lastError = null;
    saveState();
    return draft;
  } finally { busy = false; }
}

async function createAndSend(opts = {}) {
  let draft;
  try { draft = await createDraft(opts); }
  catch (e) { state.lastError = (e.message || '').slice(0, 300); saveState(); await notifyOwner(`❌ Non sono riuscito a preparare l'articolo: ${esc(state.lastError)}\n\nRiprova con /nuovo`); throw e; }
  if (owner()) { try { await sendDraft(draft); } catch (e) { warn('invio bozza fallito:', e.message); } }
  return draft;
}

async function regenerate(draft, { feedback = null, onlyImage = false } = {}) {
  const fb = draft.feedback.slice(); if (feedback) fb.push(feedback);
  if (onlyImage) {
    if (busy) throw new Error('operazione già in corso');
    busy = true;
    try {
      const topic = pickTopic(draft.topicId);
      const image = await makeCover(draft.article, topic);
      const nd = { ...draft, id: crypto.randomBytes(8).toString('hex'), image, createdAt: Date.now(), status: 'pending', messageIds: [], version: (draft.version || 1) + 1 };
      draft.status = 'superseded'; state.drafts[nd.id] = nd; saveState();
      return nd;
    } finally { busy = false; }
  }
  return createDraft({ topicId: draft.topicId, feedback: fb, previous: draft.article, keepImage: feedback ? draft.image : null });
}

async function handlePublish(draft, chatId) {
  if (draft.status === 'published') return send(chatId, `Già pubblicato: ${draft.url}`);
  await send(chatId, '⏳ Pubblico sul sito…');
  try {
    const url = await publish(draft);
    await send(chatId, `✅ <b>Pubblicato</b>\n${url}\n\nIndice del blog e sitemap aggiornati, motori avvisati con IndexNow. Prossimo articolo: ${fmtWhen(state.nextRunAt)}.`, { disable_web_page_preview: false });
  } catch (e) {
    draft.status = 'pending'; state.lastError = 'pubblicazione: ' + (e.message || '').slice(0, 300); saveState();
    warn('pubblicazione fallita:', e.message);
    await send(chatId, `❌ Pubblicazione fallita: ${esc((e.message || '').slice(0, 300))}\n\nLa bozza resta valida: riprova con /pubblica`);
  }
}

const HELP = `Sono il bot del blog di adrianolombardo.art.
Ogni ${INTERVAL_DAYS} giorni ti mando un articolo nuovo (testo + copertina) e lo pubblico solo quando premi «Pubblica».

Comandi:
/nuovo — prepara subito un articolo (anche: /nuovo id-argomento)
/pubblica — pubblica l'ultima bozza in attesa
/stato — cosa c'è in attesa e quando arriva il prossimo
/argomenti — lista degli argomenti in coda
/salta — scarta l'argomento in attesa e passa al prossimo
/pausa e /riprendi — ferma o riattiva la cadenza automatica
/aiuto — questo messaggio

Per correggere un articolo in attesa basta rispondere con un messaggio: lo riscrivo e te lo rimando.`;

async function onMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  const text = String(msg.text || '').trim();
  if (!chatId) return;
  if (!owner()) {
    if (/^\/start/.test(text)) { state.ownerChatId = chatId; if (!state.nextRunAt) state.nextRunAt = nextSlot(INTERVAL_DAYS); saveState(); log('proprietario collegato:', chatId); return send(chatId, `Ciao Adriano, collegato ✅\n\n${esc(HELP)}\n\nPrimo articolo automatico: ${fmtWhen(state.nextRunAt)}. Se vuoi vederne uno adesso: /nuovo`); }
    return send(chatId, 'Questo bot è privato.');
  }
  if (chatId !== owner()) return send(chatId, 'Questo bot è privato.');
  const cmd = (/^\/([a-z]+)(?:@\w+)?\s*(.*)$/i.exec(text) || [])[1];
  const arg = (/^\/[a-z]+(?:@\w+)?\s*(.*)$/i.exec(text) || [])[2] || '';
  const pending = pendingDraft();
  try {
    switch ((cmd || '').toLowerCase()) {
      case 'start': case 'aiuto': case 'help': return send(chatId, esc(HELP));
      case 'nuovo': case 'new':
        await send(chatId, `⏳ Preparo l'articolo${arg ? ' su «' + esc(arg) + '»' : ''}: testo e copertina richiedono 1-3 minuti…`);
        await createAndSend({ topicId: arg || null });
        return;
      case 'pubblica': case 'publish':
        if (!pending) return send(chatId, 'Nessuna bozza in attesa. Usa /nuovo.');
        return handlePublish(pending, chatId);
      case 'stato': case 'status': return send(chatId, esc(statusText()));
      case 'argomenti': case 'topics': {
        const all = topics().topics;
        const lines = all.map(t => `${state.usedTopics.includes(t.id) ? '✔' : '•'} [${formatOf(t.format)}] ${t.id} — ${t.title}`);
        return send(chatId, `<b>Argomenti</b> (✔ = già usato)\n\n${esc(lines.join('\n'))}\n\nPer sceglierne uno: /nuovo id-argomento`);
      }
      case 'salta': case 'skip':
        if (!pending) return send(chatId, 'Nessuna bozza in attesa.');
        pending.status = 'rejected'; if (!state.usedTopics.includes(pending.topicId)) state.usedTopics.push(pending.topicId); saveState();
        return send(chatId, `Scartato «${esc(pending.article.title)}». Il prossimo argomento arriva ${fmtWhen(state.nextRunAt)}, oppure /nuovo.`);
      case 'pausa': case 'pause': state.paused = true; saveState(); return send(chatId, 'Cadenza automatica in pausa. /riprendi per riattivarla.');
      case 'riprendi': case 'resume': state.paused = false; if (!state.nextRunAt || state.nextRunAt < Date.now()) state.nextRunAt = nextSlot(INTERVAL_DAYS); saveState(); return send(chatId, `Riattivata. Prossimo articolo: ${fmtWhen(state.nextRunAt)}.`);
      default:
        if (cmd) return send(chatId, 'Comando sconosciuto. /aiuto');
        if (!text) return;
        if (!pending) return send(chatId, 'Nessuna bozza in attesa a cui applicare la correzione. Usa /nuovo per un articolo nuovo.');
        if (/^genera (l'|la |un'|una )?(immagine|copertina|foto)/i.test(text)) {
          await send(chatId, '🖼 Genero una copertina per questo articolo…');
          const tp = Object.assign({}, topics().topics.find(t => t.id === pending.topicId) || {}, { cover: 'generate' });
          if (busy) throw new Error('operazione già in corso');
          busy = true;
          let nd;
          try {
            const image = await makeCover(pending.article, tp);
            nd = { ...pending, id: crypto.randomBytes(8).toString('hex'), image, createdAt: Date.now(), status: 'pending', messageIds: [], version: (pending.version || 1) + 1 };
            pending.status = 'superseded'; state.drafts[nd.id] = nd; saveState();
          } finally { busy = false; }
          await sendDraft(nd, { onlyImage: true });
          return;
        }
        await send(chatId, `✏️ Riscrivo «${esc(pending.article.title)}» con la tua correzione: «${esc(text)}». Un minuto…`);
        { const nd = await regenerate(pending, { feedback: text }); await sendDraft(nd); }
        return;
    }
  } catch (e) {
    warn('gestione messaggio:', e.message);
    await send(chatId, `❌ ${esc((e.message || '').slice(0, 300))}`);
  }
}

async function onCallback(cb) {
  const chatId = cb.message && cb.message.chat && cb.message.chat.id;
  const [action, id] = String(cb.data || '').split(':');
  const draft = state.drafts[id];
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, text: text || '' }).catch(() => {});
  if (!owner() || chatId !== owner()) return answer('Bot privato');
  if (!draft) return answer('Bozza non trovata (forse è vecchia)');
  try { await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (e) {}
  try {
    if (action === 'pub') {
      if (draft.status !== 'pending' && draft.status !== 'published') { await answer('Questa bozza è stata sostituita'); return send(chatId, 'Questa bozza è stata sostituita da una più recente: usa i pulsanti dell\'ultima.'); }
      await answer('Pubblico…'); return handlePublish(draft, chatId);
    }
    if (action === 'rej') {
      await answer('Scartato');
      draft.status = 'rejected'; if (!state.usedTopics.includes(draft.topicId)) state.usedTopics.push(draft.topicId); saveState();
      return send(chatId, `Scartato «${esc(draft.article.title)}». Prossimo articolo: ${fmtWhen(state.nextRunAt)}, oppure /nuovo.`);
    }
    if (action === 'regen') {
      await answer('Riscrivo…'); await send(chatId, `🔁 Riscrivo da capo «${esc(draft.article.title)}»: 1-3 minuti…`);
      const nd = await regenerate(draft, { feedback: 'Riscrivi da capo con un taglio diverso e più concreto, mantenendo lo stesso argomento.' });
      return sendDraft(nd);
    }
    if (action === 'img') {
      const tp = topics().topics.find(t => t.id === draft.topicId);
      if (tp && tp.cover === 'site') { await answer('Foto dell\'opera'); return send(chatId, `Questo articolo usa la foto vera dell'opera (${esc(tp.fallback)}), come hai chiesto. Se vuoi un'immagine generata, rispondi con «genera l'immagine».`); }
      await answer('Nuova immagine…'); await send(chatId, '🖼 Genero una nuova copertina…');
      const nd = await regenerate(draft, { onlyImage: true });
      return sendDraft(nd, { onlyImage: true });
    }
    return answer('Azione sconosciuta');
  } catch (e) {
    warn('callback:', e.message);
    await send(chatId, `❌ ${esc((e.message || '').slice(0, 300))}`);
  }
}

async function handleUpdate(u) {
  try {
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  } catch (e) { warn('update:', e.message); }
}

/* ── webhook (Railway) o polling (locale) ── */
async function setupTelegram() {
  if (!TOKEN()) { log('TELEGRAM_BOT_TOKEN assente: blog automatico spento'); return; }
  try { const me = await tg('getMe'); log(`bot @${me.username} pronto`); } catch (e) { warn('getMe fallito (token sbagliato?):', e.message); return; }
  if (publicUrl && env('TELEGRAM_WEBHOOK') === '1') {
    try {
      await tg('setWebhook', { url: `${publicUrl}/api/telegram/webhook/${webhookSecret()}`, secret_token: webhookSecret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      const info = await tg('getWebhookInfo').catch(() => ({}));
      log(`webhook Telegram impostato su ${publicUrl} · in coda: ${info.pending_update_count || 0}${info.last_error_message ? ' · ultimo errore: ' + info.last_error_message : ''}`);
    } catch (e) { warn('setWebhook fallito, passo al polling:', e.message); startPolling(); }
  } else startPolling();
}
function startPolling() {
  if (pollingAbort) return;
  pollingAbort = { stop: false };
  const ctl = pollingAbort;
  (async () => {
    try { await tg('deleteWebhook', { drop_pending_updates: false }); } catch (e) { warn('deleteWebhook:', e.message); }
    try { const info = await tg('getWebhookInfo'); log(`polling Telegram attivo · aggiornamenti in coda: ${info.pending_update_count || 0}${info.last_error_message ? ' · ultimo errore webhook: ' + info.last_error_message : ''}`); } catch (e) { log('polling Telegram attivo'); }
    let failures = 0;
    while (!ctl.stop) {
      try {
        const updates = await tg('getUpdates', { offset: state.pollOffset || 0, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        failures = 0;
        for (const u of updates) {
          state.pollOffset = u.update_id + 1; saveState();
          const m = u.message || (u.callback_query && u.callback_query.message) || {};
          log(`update ${u.update_id}: ${u.callback_query ? 'pulsante ' + u.callback_query.data : 'messaggio "' + String(u.message && u.message.text || '').slice(0, 40) + '"'} da chat ${m.chat && m.chat.id}`);
          await handleUpdate(u);
        }
      } catch (e) {
        failures++;
        warn('polling:', e.message);
        await new Promise(r => setTimeout(r, Math.min(60000, 5000 * failures)));
      }
    }
  })();
}

/* ── scheduler ── */
async function tick() {
  if (!TOKEN() || !owner() || state.paused || busy) return;
  const pending = pendingDraft();
  if (pending) {
    if (Date.now() - (state.lastReminderAt || pending.createdAt) > 3 * 86400000) {
      state.lastReminderAt = Date.now(); saveState();
      await notifyOwner(`⏰ C'è ancora un articolo in attesa: «${esc(pending.article.title)}». Rispondi ai pulsanti sopra, oppure /pubblica, /salta, /stato.`);
    }
    return;
  }
  if (!state.nextRunAt) { state.nextRunAt = nextSlot(INTERVAL_DAYS); saveState(); return; }
  if (Date.now() < state.nextRunAt) return;
  state.nextRunAt = nextSlot(INTERVAL_DAYS); saveState();
  try { await createAndSend(); } catch (e) { warn('ciclo automatico:', e.message); }
}

function statusText() {
  const pending = pendingDraft();
  const t = topics().topics;
  const left = t.filter(x => !state.usedTopics.includes(x.id)).length;
  return [
    `Cadenza: ogni ${INTERVAL_DAYS} giorni alle ${String(SEND_HOUR).padStart(2, '0')}:00${state.paused ? ' (IN PAUSA)' : ''}`,
    `Prossimo articolo: ${fmtWhen(state.nextRunAt)}`,
    `In attesa: ${pending ? '«' + pending.article.title + '» (v' + (pending.version || 1) + ', dal ' + fmtWhen(pending.createdAt) + ')' : 'niente'}`,
    `Pubblicati dal bot: ${state.published.length}${state.published.length ? ' — ultimo: ' + state.published[state.published.length - 1].title : ''}`,
    `Argomenti rimasti: ${left} su ${t.length}`,
    `Testo: ${llm.available()} · Immagini: ${env('GEMINI_API_KEY') ? 'Gemini' : 'foto del sito'} · FTP: ${ftpConfigured() ? 'ok' : 'NON configurato'}`,
    state.lastError ? `Ultimo errore: ${state.lastError}` : '',
  ].filter(Boolean).join('\n');
}

/* ══════════════════════════════════════════════════
   INIT — rotte Express + scheduler
   ──────────────────────────────────────────────── */
function init({ app, dataDir, adminAuth, publicUrl: pu }) {
  DATA_DIR = dataDir || __dirname;
  STATE_FILE = path.join(DATA_DIR, 'blog-state.json');
  WORK_DIR = path.join(DATA_DIR, 'blog-work');
  fs.mkdirSync(WORK_DIR, { recursive: true });
  publicUrl = (pu || '').replace(/\/$/, '');
  loadState();

  // Telegram webhook
  app.post('/api/telegram/webhook/:secret', (req, res) => {
    const ok = TOKEN() && req.params.secret === webhookSecret() && String(req.headers['x-telegram-bot-api-secret-token'] || '') === webhookSecret();
    if (!ok) { warn('webhook rifiutato (secret non valido) da', req.ip); return res.status(403).end(); }
    res.json({ ok: true });
    const u = req.body || {};
    const m = u.message || (u.callback_query && u.callback_query.message) || {};
    log(`webhook update ${u.update_id}: ${u.callback_query ? 'pulsante ' + u.callback_query.data : 'messaggio "' + String(u.message && u.message.text || '').slice(0, 40) + '"'} da chat ${m.chat && m.chat.id}`);
    handleUpdate(u);
  });
  // anteprima bozza (id casuale a 16 caratteri esadecimali, non indicizzata)
  app.get('/api/blog/preview/:id', (req, res) => {
    const d = state.drafts[String(req.params.id || '')];
    if (!d) return res.status(404).send('Bozza non trovata');
    const img = { ...d.image };
    if (img.kind === 'gemini' && img.files.length) { img.src = `${publicUrl || ''}/api/blog/preview/${d.id}/cover.jpg`; img.srcset = ''; img.og = img.src; }
    res.set('Cache-Control', 'no-store').type('html').send(renderArticle(d.article, img, d.date || todayIso(), { preview: true }));
  });
  app.get('/api/blog/preview/:id/cover.jpg', (req, res) => {
    const d = state.drafts[String(req.params.id || '')];
    if (!d || !d.image.preview || !fs.existsSync(d.image.preview)) return res.status(404).end();
    res.set('Cache-Control', 'no-store').sendFile(d.image.preview);
  });
  // admin
  app.get('/api/admin/blog', adminAuth, (req, res) => res.json({ status: statusText(), state: { ownerChatId: state.ownerChatId, paused: state.paused, nextRunAt: state.nextRunAt, nextRun: fmtWhen(state.nextRunAt), usedTopics: state.usedTopics, published: state.published, lastError: state.lastError, drafts: draftsSorted().map(d => ({ id: d.id, status: d.status, title: d.article.title, slug: d.article.slug, words: d.article.words, image: d.image.kind, createdAt: d.createdAt, version: d.version })) } }));
  app.post('/api/admin/blog/run', adminAuth, async (req, res) => {
    try { const d = await createAndSend({ topicId: (req.body && req.body.topic) || null }); res.json({ ok: true, id: d.id, title: d.article.title, words: d.article.words, image: d.image.kind, preview: publicUrl ? `${publicUrl}/api/blog/preview/${d.id}` : null }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/blog/publish/:id', adminAuth, async (req, res) => {
    const d = state.drafts[String(req.params.id || '')];
    if (!d) return res.status(404).json({ error: 'bozza non trovata' });
    try { const url = await publish(d); res.json({ ok: true, url }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/admin/blog/owner', adminAuth, (req, res) => { state.ownerChatId = Number(req.body && req.body.chatId) || null; saveState(); res.json({ ok: true, ownerChatId: state.ownerChatId }); });
  app.post('/api/admin/blog/telegram-test', adminAuth, async (req, res) => {
    try { await notifyOwner('✅ Test dal server: il bot del blog è collegato.'); res.json({ ok: true, ownerChatId: state.ownerChatId }); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  setTimeout(() => { setupTelegram(); }, 3000);
  setInterval(() => { tick().catch(e => warn('tick:', e.message)); }, 5 * 60 * 1000);
  setTimeout(() => { tick().catch(e => warn('tick:', e.message)); }, 45 * 1000);
  log(`pronto: ogni ${INTERVAL_DAYS} giorni alle ${SEND_HOUR}:00 ${TZ} · Telegram ${TOKEN() ? 'ok' : 'NO'} · FTP ${ftpConfigured() ? 'ok' : 'NO'} · immagini ${env('GEMINI_API_KEY') ? 'Gemini' : 'foto del sito'}${MOCK ? ' · MOCK' : ''}${DRY_RUN ? ' · DRY RUN' : ''}`);
}

module.exports = { init, statusText, createDraft, publish, renderArticle, renderCard, insertCard, updateSitemap, updateFeed, feedEntry, htmlToTelegram, parseSections, sanitizeBody, makeCover, buildImageSet, _state: () => state };
