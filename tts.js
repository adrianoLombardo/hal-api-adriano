/* ════════════════════════════════════════════════
   HAL 9000 — TTS providers (voce)
   Catena: ElevenLabs → OpenAI → Azure → Gemini (gratis con chiave) → Edge (gratis, senza chiave)
   Ogni provider restituisce { audio: Buffer, mime, provider, voice }.
   La lingua (it/en) sceglie la voce: HAL parla nella lingua dell'utente.
   ──────────────────────────────────────────────── */
const crypto = require('crypto');
const WebSocket = require('ws');

const env = (k, d = '') => (process.env[k] || d).trim();

/* ── Lingua: euristica leggera su stopword (it/en) ── */
const IT_WORDS = new Set('che di il la lo gli le un una uno per non con sono come cosa ciao del della dei delle mi ti ci vi ho hai ha abbiamo sei siamo questo questa questi anche ma perché perche quando dove chi grazie tu io nel nella sul sulla alla da se più piu fare puoi vorrei sai tuo tua mio mia suo sua buongiorno buonasera salve bene qui qua c\'è cè quale quali cos\'è dimmi parlami raccontami sei'.split(' '));
const EN_WORDS = new Set('the is are you what how and of to in it that this i do does can my your hello hi hey who where when why with for about tell me thanks thank please would like have has was were be not on an at from we they he she our their there here good morning evening yes no know want should could'.split(' '));

function detectLang(text, fallback = 'it') {
  if (!text) return fallback;
  const words = String(text).toLowerCase().replace(/[^a-zàèéìòù'\s]/g, ' ').split(/\s+/).filter(Boolean);
  let it = 0, en = 0;
  for (const w of words) { if (IT_WORDS.has(w)) it++; if (EN_WORDS.has(w)) en++; }
  if (it === en) {
    // accenti italiani decidono i pareggi
    if (/[àèéìòù]/.test(text)) return 'it';
    return fallback;
  }
  return en > it ? 'en' : 'it';
}

/* ── Voci per lingua ── */
// Voci multilingue: le più naturali del catalogo, pronunciano bene anche i nomi inglesi dentro l'italiano
const VOICE = {
  edge:  { it: () => env('HAL_VOICE_IT', 'it-IT-GiuseppeMultilingualNeural'), en: () => env('HAL_VOICE_EN', 'en-US-AndrewMultilingualNeural') },
  azure: { it: () => env('HAL_VOICE_IT', 'it-IT-GiuseppeMultilingualNeural'), en: () => env('HAL_VOICE_EN', 'en-US-AndrewMultilingualNeural') },
  openai: () => env('OPENAI_TTS_VOICE', 'onyx'),
  elevenlabs: () => env('ELEVENLABS_VOICE_ID', 'q2LDrL29FLqRR3XanHLq'),
};
// Prosodia HAL: calmo, appena più lento del normale; niente pitch shift (deforma le voci neurali)
const PROSODY = { it: { rate: env('HAL_VOICE_RATE_IT', '-5%'), pitch: env('HAL_VOICE_PITCH_IT', '-12%') }, en: { rate: env('HAL_VOICE_RATE_EN', '-6%'), pitch: env('HAL_VOICE_PITCH_EN', '-8%') } };

/* ── Pronuncia: sigle e nomi che i motori leggono male ("HAL" → "acca a elle") ── */
function normalizeForSpeech(text, lang = 'it') {
  let t = String(text || '');
  const it = lang !== 'en';
  t = t.replace(/\bHAL[\s-]?9000\b/gi, it ? 'Hal novemila' : 'Hal nine thousand');
  t = t.replace(/\bHAL\b/g, 'Hal');
  t = t.replace(/Neuro[.\s]?Flow/gi, 'Neuro Flow');
  t = t.replace(/adrianolombardo\.art/gi, it ? 'adriano lombardo punto art' : 'adriano lombardo dot art');
  t = t.replace(/holyclub\.it/gi, it ? 'holy club punto it' : 'holy club dot it');
  t = t.replace(/TouchDesigner/g, 'Touch Designer');
  t = t.replace(/\bEEG\b/g, it ? 'e-e-gi' : 'E E G');
  t = t.replace(/\bPLV\b/g, it ? 'pi-elle-vu' : 'P L V');
  t = t.replace(/\bUV\b/g, it ? 'u-vu' : 'U V');
  t = t.replace(/\bLED\b/g, 'led');
  t = t.replace(/\b(IA|AI)\b/g, it ? 'i a' : 'A I');
  t = t.replace(/\bHUD\b/g, it ? 'ad' : 'hud');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

const HAL_STYLE = {
  it: 'Sei HAL 9000. Parla con calma assoluta, lentamente, con voce bassa, uniforme e cortese, leggermente inquietante ma mai teatrale. Italiano naturale, pause brevi tra le frasi.',
  en: 'You are HAL 9000. Speak with absolute calm, slowly, in a low, even, courteous voice, faintly unsettling but never theatrical. Natural English, short pauses between sentences.',
};

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const EN_TERMS = /\b(Hal|Neuro Flow|creative technologist|Holy Club|Liquid Thoughts|Sailing Through Memories|The Cathedral|Interconnection|Fake Machine|The Contact|Touch Designer|projection mapping|light design|Bright Festival|Sublime|showreel)\b/gi;
function ssmlFor(text, lang, voice) {
  const p = PROSODY[lang] || PROSODY.it;
  const xmlLang = lang === 'en' ? 'en-US' : 'it-IT';
  if (/^\s*<speak/i.test(text)) return text; // SSML già pronto (test/varianti)
  let body = escapeXml(text);
  // <lang> funziona solo su Azure (Edge chiude la connessione): sui multilingue Azure i nomi inglesi vengono letti in inglese
  if (lang !== 'en' && /Multilingual/i.test(voice) && env('HAL_SSML_LANG_TAGS', '0') === '1') body = body.replace(EN_TERMS, (m) => `<lang xml:lang="en-US">${m}</lang>`);
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='${xmlLang}'>` +
    `<voice name='${voice}'><prosody pitch='${p.pitch}' rate='${p.rate}' volume='+0%'>${body}</prosody></voice></speak>`;
}

/* ══════════════════════════════════════════════
   1) ElevenLabs
   ══════════════════════════════════════════════ */
let elFormatOverride = null; // se il piano non supporta il formato richiesto, ripiega su 128k
async function elevenlabs(text, lang, signal) {
  const key = env('ELEVENLABS_API_KEY');
  if (!key) return null;
  const voiceId = VOICE.elevenlabs();
  const format = elFormatOverride || env('ELEVENLABS_FORMAT', 'mp3_44100_128');
  const doFetch = (fmt) => fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${fmt}&optimize_streaming_latency=3`, {
    method: 'POST', signal,
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, model_id: env('ELEVENLABS_MODEL', 'eleven_flash_v2_5'), language_code: lang,
      voice_settings: { stability: 0.75, similarity_boost: 0.85, style: 0.0, use_speaker_boost: false, speed: 0.92 },
    }),
  });
  let res = await doFetch(format);
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    if (/output format|tier/i.test(err) && format !== 'mp3_44100_128') {
      console.warn(`[TTS] ElevenLabs: formato ${format} non disponibile sul piano, uso mp3_44100_128`);
      elFormatOverride = 'mp3_44100_128';
      res = await doFetch('mp3_44100_128');
      if (!res.ok) throw new Error(`ElevenLabs ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    } else {
      throw new Error(`ElevenLabs ${res.status} ${err.slice(0, 120)}`);
    }
  }
  return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', provider: 'elevenlabs', voice: voiceId };
}

/* ══════════════════════════════════════════════
   2) OpenAI gpt-4o-mini-tts (istruzioni in linguaggio naturale)
   ══════════════════════════════════════════════ */
async function openai(text, lang, signal) {
  const key = env('OPENAI_API_KEY');
  if (!key) return null;
  const voice = VOICE.openai();
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts'), voice, input: text, instructions: HAL_STYLE[lang] || HAL_STYLE.it, response_format: 'mp3', speed: 0.95 }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
  return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', provider: 'openai', voice };
}

/* ══════════════════════════════════════════════
   3) Azure Speech (chiave + regione) — SSML completo
   ══════════════════════════════════════════════ */
async function azure(text, lang, signal) {
  const key = env('AZURE_TTS_KEY'); const region = env('AZURE_TTS_REGION');
  if (!key || !region) return null;
  const voice = VOICE.azure[lang === 'en' ? 'en' : 'it']();
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST', signal,
    headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'HAL9000' },
    body: ssmlFor(text, lang, voice),
  });
  if (!res.ok) throw new Error(`Azure TTS ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
  return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg', provider: 'azure', voice };
}

/* ══════════════════════════════════════════════
   3b) Gemini TTS — voci neurali Google, stile guidato dal testo,
       gratuito nel piano free della stessa GEMINI_API_KEY del cervello
   ══════════════════════════════════════════════ */
function pcmToWav(pcm, rate = 24000, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function gemini(text, lang, signal) {
  const key = env('GEMINI_API_KEY');
  if (!key || env('HAL_TTS_GEMINI', '1') === '0') return null;
  const model = env('GEMINI_TTS_MODEL', 'gemini-2.5-flash-preview-tts');
  const voice = env('GEMINI_TTS_VOICE', 'Charon');
  const style = lang === 'en'
    ? env('GEMINI_TTS_STYLE_EN', 'Read the following as HAL 9000: calm, unhurried, low and even voice, courteous, faintly unsettling, natural English.')
    : env('GEMINI_TTS_STYLE_IT', 'Leggi il testo seguente come HAL 9000: calmo, senza fretta, voce bassa e uniforme, cortese, appena inquietante, italiano naturale.');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', signal,
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${style}\n\n${text}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini TTS ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const part = parts.find(x => x.inlineData && x.inlineData.data);
  if (!part) throw new Error('Gemini TTS: nessun audio nella risposta');
  const pcm = Buffer.from(part.inlineData.data, 'base64');
  const mime = part.inlineData.mimeType || '';
  if (/wav|mpeg|mp3|ogg/i.test(mime) && !/L16|pcm/i.test(mime)) return { audio: pcm, mime: mime.split(';')[0], provider: 'gemini', voice };
  const rate = parseInt((mime.match(/rate=(\d+)/) || [])[1] || '24000', 10);
  return { audio: pcmToWav(pcm, rate), mime: 'audio/wav', provider: 'gemini', voice };
}

/* ══════════════════════════════════════════════
   4) Edge Read Aloud — voci neurali Microsoft, gratis, senza chiave
      (stesso servizio usato da "Leggi ad alta voce" di Edge; API non ufficiale)
   ══════════════════════════════════════════════ */
const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_CHROMIUM = '143.0.3650.75';
const EDGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
let edgeClockSkew = 0; // secondi, corretto dall'header Date del server se l'orologio locale è sfasato

function edgeSecMsGec() {
  let ticks = (BigInt(Math.floor(Date.now() / 1000 + edgeClockSkew)) + 11644473600n) * 10000000n;
  ticks -= ticks % 3000000000n; // arrotonda a 5 minuti
  return crypto.createHash('sha256').update(`${ticks}${EDGE_TOKEN}`).digest('hex').toUpperCase();
}
function edgeDate() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

async function edge(text, lang, signal, timeoutMs = 12000) {
  if (env('HAL_TTS_PROVIDER', 'auto') === 'none') return null;
  try { return await edgeOnce(text, lang, signal, timeoutMs); }
  catch (e) {
    if (signal && signal.aborted) throw e;
    // un secondo tentativo: dopo la correzione dello skew (401/403) o su connessione chiusa dal server (transitoria)
    return edgeOnce(text, lang, signal, timeoutMs);
  }
}
function edgeOnce(text, lang, signal, timeoutMs) {
  const voice = VOICE.edge[lang === 'en' ? 'en' : 'it']();
  return new Promise((resolve, reject) => {
    const connId = crypto.randomUUID().replace(/-/g, '');
    const reqId = crypto.randomUUID().replace(/-/g, '');
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${edgeSecMsGec()}&Sec-MS-GEC-Version=1-${EDGE_CHROMIUM}&ConnectionId=${connId}`;
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache', 'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': EDGE_UA,
      },
    });
    const chunks = [];
    let settled = false;
    const finish = (err) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { ws.close(); } catch (e) {}
      if (err) return reject(err);
      const audio = Buffer.concat(chunks);
      if (audio.length < 200) return reject(new Error('Edge TTS: audio vuoto'));
      resolve({ audio, mime: 'audio/mpeg', provider: 'edge', voice });
    };
    const onAbort = () => { try { ws.terminate(); } catch (e) {} finish(new Error('Edge TTS: annullato')); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { try { ws.terminate(); } catch (e) {} finish(new Error('Edge TTS: timeout')); }, timeoutMs);

    ws.on('open', () => {
      ws.send(`X-Timestamp:${edgeDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      ws.send(`X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${edgeDate()}Z\r\nPath:ssml\r\n\r\n${ssmlFor(text, lang, voice)}`);
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString().includes('Path:turn.end')) finish();
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 2) return;
      const hlen = buf.readUInt16BE(0);
      const header = buf.subarray(2, 2 + hlen).toString();
      if (header.includes('Path:audio')) chunks.push(buf.subarray(2 + hlen));
    });
    ws.on('unexpected-response', (req, res) => {
      const d = Date.parse(res.headers && res.headers.date);
      if (d) edgeClockSkew = Math.round((d - Date.now()) / 1000);
      try { res.resume(); } catch (e) {}
      finish(new Error('Edge TTS: HTTP ' + res.statusCode));
    });
    ws.on('error', (e) => finish(new Error('Edge TTS: ' + e.message)));
    ws.on('close', () => finish(chunks.length ? null : new Error('Edge TTS: connessione chiusa')));
  });
}

/* ══════════════════════════════════════════════
   Catena provider + cache delle frasi ricorrenti (saluti)
   ══════════════════════════════════════════════ */
const PROVIDERS = { elevenlabs, openai, azure, gemini, edge };
function providerOrder() {
  const forced = env('HAL_TTS_PROVIDER', 'auto').toLowerCase();
  if (forced === 'none') return [];
  if (forced !== 'auto' && PROVIDERS[forced]) return [forced, 'edge'].filter((v, i, a) => a.indexOf(v) === i);
  const order = [];
  if (env('ELEVENLABS_API_KEY')) order.push('elevenlabs');
  if (env('OPENAI_API_KEY')) order.push('openai');
  if (env('AZURE_TTS_KEY') && env('AZURE_TTS_REGION')) order.push('azure');
  if (env('GEMINI_API_KEY') && env('HAL_TTS_GEMINI', '1') !== '0') order.push('gemini');
  order.push('edge');
  return order;
}
const cooldown = {}; // provider → timestamp fino a cui è sospeso (chiave non valida, piano insufficiente)
const usable = (name) => !(cooldown[name] > Date.now());
function available() { const o = providerOrder().filter(usable); return o.length ? o[0] : 'none'; }

const cache = new Map(); const CACHE_MAX = 60;
function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
function cacheSet(k, v) { cache.set(k, v); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }

/**
 * synthesize(text, {lang, signal}) → {audio, mime, provider, voice} | null
 * Prova i provider in ordine; null solo se nessuno funziona (il client usa la voce del browser).
 */
async function synthesize(text, { lang = 'it', signal, timeoutMs = 15000 } = {}) {
  const clean = normalizeForSpeech(text, lang);
  if (!clean) return null;
  const order = providerOrder();
  if (!order.length) return null;
  const first = order.find(usable) || 'none';
  const voiceKey = VOICE[first] ? (typeof VOICE[first] === 'function' ? VOICE[first]() : VOICE[first][lang === 'en' ? 'en' : 'it']()) : '';
  const key = `${first}|${voiceKey}|${lang}|${clean}`;
  const hit = cacheGet(key);
  if (hit) return { ...hit, cached: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    for (const name of order) {
      if (!usable(name)) continue;
      try {
        const out = await PROVIDERS[name](clean, lang, ctrl.signal);
        if (out) { if (clean.length < 400) cacheSet(key, out); return out; }
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        console.warn(`[TTS] ${name} fallito: ${e.message}`);
        if (/\b(401|402|403)\b/.test(e.message)) { cooldown[name] = Date.now() + 10 * 60 * 1000; console.warn(`[TTS] ${name} sospeso per 10 minuti`); }
      }
    }
    return null;
  } finally { clearTimeout(timer); }
}

/* Divide il testo in frasi "parlabili" (per il TTS in streaming) */
function splitSentences(text, { minLen = 30 } = {}) {
  const parts = String(text).split(/(?<=[.!?…:;])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (out.length && out[out.length - 1].length < minLen) out[out.length - 1] += ' ' + p;
    else out.push(p);
  }
  return out;
}

module.exports = { synthesize, available, providerOrder, detectLang, splitSentences, ssmlFor, normalizeForSpeech, PROSODY, edge };
