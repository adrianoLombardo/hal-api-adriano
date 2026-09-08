/* ════════════════════════════════════════════════
   HAL 9000 — LLM providers (il cervello)
   Catena: Anthropic → Gemini → Groq → OpenRouter → Cerebras → Mistral
   Tutti tranne Anthropic parlano il formato OpenAI (chat/completions).
   Con una chiave gratuita (GEMINI_API_KEY da aistudio.google.com o
   GROQ_API_KEY da console.groq.com) HAL funziona senza costi.
   HAL_LLM_PROVIDER = auto | anthropic | gemini | groq | openrouter | cerebras | mistral
   (anche lista: "gemini,groq,anthropic" = ordine forzato, il resto come riserva)
   ──────────────────────────────────────────────── */
const env = (k, d = '') => (process.env[k] || d).trim();
const uniq = (a) => a.filter((v, i) => v && a.indexOf(v) === i);

const P = {
  anthropic: {
    keyVar: 'ANTHROPIC_API_KEY', kind: 'anthropic',
    models: () => uniq([env('ANTHROPIC_MODEL'), 'claude-haiku-4-5-20251001']),
    visionModels: () => uniq([env('ANTHROPIC_MODEL'), 'claude-haiku-4-5-20251001']),
  },
  gemini: {
    keyVar: 'GEMINI_API_KEY', kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: () => uniq([env('GEMINI_MODEL'), 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']),
    visionModels: () => uniq([env('GEMINI_VISION_MODEL'), env('GEMINI_MODEL'), 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']),
  },
  groq: {
    keyVar: 'GROQ_API_KEY', kind: 'openai', base: 'https://api.groq.com/openai/v1',
    models: () => uniq([env('GROQ_MODEL'), 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b']),
    visionModels: () => uniq([env('GROQ_VISION_MODEL'), 'meta-llama/llama-4-scout-17b-16e-instruct']),
  },
  openrouter: {
    keyVar: 'OPENROUTER_API_KEY', kind: 'openai', base: 'https://openrouter.ai/api/v1',
    headers: { 'HTTP-Referer': 'https://adrianolombardo.art', 'X-Title': 'HAL 9000' },
    models: () => uniq([env('OPENROUTER_MODEL'), 'meta-llama/llama-3.3-70b-instruct:free']),
    visionModels: () => uniq([env('OPENROUTER_VISION_MODEL')]),
  },
  cerebras: {
    keyVar: 'CEREBRAS_API_KEY', kind: 'openai', base: 'https://api.cerebras.ai/v1',
    models: () => uniq([env('CEREBRAS_MODEL'), 'llama-3.3-70b']),
    visionModels: () => [],
  },
  mistral: {
    keyVar: 'MISTRAL_API_KEY', kind: 'openai', base: 'https://api.mistral.ai/v1',
    models: () => uniq([env('MISTRAL_MODEL'), 'mistral-small-latest']),
    visionModels: () => uniq([env('MISTRAL_VISION_MODEL'), 'pixtral-12b-latest']),
  },
};
const ALL = ['anthropic', 'gemini', 'groq', 'openrouter', 'cerebras', 'mistral'];

function order() {
  const forced = env('HAL_LLM_PROVIDER', 'auto').toLowerCase();
  let list = ALL;
  if (forced !== 'auto') {
    const wanted = forced.split(',').map(s => s.trim()).filter(n => P[n]);
    list = wanted.concat(ALL.filter(n => !wanted.includes(n)));
  }
  return list.filter(n => env(P[n].keyVar));
}

const cooldown = {};   // provider → timestamp fino a cui è sospeso
const badModel = {};   // "provider|model" → true (modello inesistente) oppure timestamp di fine pausa (quota 429)
const usable = (n) => !(cooldown[n] > Date.now());
function available() { return order().filter(usable)[0] || 'none'; }
function configured() { return order().length > 0; }
function isFree() { const a = available(); return a !== 'none' && a !== 'anthropic'; }
function modelsStatus() {
  const out = {};
  for (const [k, v] of Object.entries(badModel)) {
    if (v === true) out[k] = 'non disponibile';
    else if (v > Date.now()) out[k] = 'pausa ' + Math.ceil((v - Date.now()) / 60000) + ' min';
  }
  return out;
}
function status() {
  return { order: order(), available: available(), models: modelsStatus(), cooldown: Object.fromEntries(Object.entries(cooldown).filter(([, t]) => t > Date.now()).map(([k, t]) => [k, Math.round((t - Date.now()) / 1000) + 's'])) };
}

class LLMError extends Error {
  constructor(message, { status, detail, provider } = {}) {
    super(message); this.name = 'LLMError'; this.status = status; this.detail = detail; this.provider = provider;
  }
}

function markFailure(name, status, detail) {
  const s = Number(status) || 0;
  if (s === 401 || s === 402 || s === 403 || (s === 400 && /credit|billing|quota|balance/i.test(detail))) cooldown[name] = Date.now() + 30 * 60 * 1000;
  else if (s === 429) cooldown[name] = Date.now() + 60 * 1000;
  else if (s >= 500) cooldown[name] = Date.now() + 30 * 1000;
}

/* ── conversione formati ── */
const systemText = (system) => Array.isArray(system) ? system.map(b => (b && b.text) || '').join('\n') : String(system || '');
function toOpenAIContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image' && part.source) return { type: 'image_url', image_url: { url: `data:${part.source.media_type || 'image/jpeg'};base64,${part.source.data}` } };
    if (part.type === 'image_url') return part;
    return { type: 'text', text: JSON.stringify(part) };
  });
}
const hasImage = (messages) => messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image' || p.type === 'image_url'));

function buildRequest(name, cfg, key, model, opts, stream) {
  if (cfg.kind === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: { model, max_tokens: opts.maxTokens || 400, system: opts.system, messages: opts.messages, ...(stream ? { stream: true } : {}) },
    };
  }
  const msgs = [];
  const sys = systemText(opts.system);
  if (sys) msgs.push({ role: 'system', content: sys });
  for (const m of opts.messages) msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toOpenAIContent(m.content) });
  const isGemini = name === 'gemini';
  const body = { model, max_tokens: isGemini ? Math.max(2048, (opts.maxTokens || 400) * 3) : (opts.maxTokens || 400), messages: msgs, ...(stream ? { stream: true } : {}) };
  if (isGemini && !opts._noReasoningField) body.reasoning_effort = 'low'; // i modelli Gemini "pensano": tienilo corto
  return {
    url: cfg.base + '/chat/completions',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(cfg.headers || {}) },
    body,
  };
}

/* Prova provider e modelli in ordine; ritorna la prima risposta OK */
async function request(opts, stream) {
  const errors = [];
  let lastStatus = 0;
  const needVision = hasImage(opts.messages || []);
  for (const name of order()) {
    if (!usable(name)) continue;
    const cfg = P[name];
    const key = env(cfg.keyVar);
    const models = needVision ? cfg.visionModels() : cfg.models();
    if (!models.length) continue;
    const pausedModels = models.filter(m => { const b = badModel[name + '|' + m]; return b === true || (typeof b === 'number' && b > Date.now()); });
    if (pausedModels.length === models.length) {
      errors.push(`${name}: tutti i modelli in pausa quota (${models.map(m => { const b = badModel[name + '|' + m]; return m + (typeof b === 'number' ? ' ' + Math.ceil((b - Date.now()) / 60000) + 'min' : ' n/d'); }).join(', ')})`);
      continue;
    }
    let providerDown = false;
    for (const model of models) {
      const bm = badModel[name + '|' + model];
      if (bm === true || (typeof bm === 'number' && bm > Date.now())) continue;
      const req = buildRequest(name, cfg, key, model, opts, stream);
      let res;
      try {
        res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 60000) });
      } catch (e) {
        errors.push(`${name}/${model}: ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
        cooldown[name] = Date.now() + 30 * 1000;
        providerDown = true;
        break;
      }
      if (res.ok) return { name, model, res, kind: cfg.kind };
      const body = await res.text().catch(() => '');
      let detail = body.slice(0, 300);
      try { detail = JSON.parse(body).error?.message || detail; } catch (e) {}
      errors.push(`${name}/${model}: ${res.status} ${detail.slice(0, 140)}`);
      lastStatus = res.status;
      if (res.status === 400 && /reasoning_effort/i.test(detail) && !opts._noReasoningField) {
        return request({ ...opts, _noReasoningField: true }, stream); // riprova senza il campo
      }
      if (res.status === 429) {
        // quota del modello (piano free): pausa solo QUEL modello e prova il successivo
        const full = body.slice(0, 2000);
        const zero = /limit(_value)?:\s*0\b|limit of 0\b/i.test(full);          // modello senza quota sul piano: escludilo
        const daily = /per ?day|PerDay|daily|RPD/i.test(full);
        const ms = zero ? 24 * 3600 * 1000 : daily ? 3 * 3600 * 1000 : 2 * 60 * 1000;
        badModel[name + '|' + model] = Date.now() + ms;
        console.warn(`[LLM] ${name}/${model} 429 → pausa ${zero ? '24 h (limite 0)' : daily ? '3 h (quota giornaliera)' : '2 min'}: ${full.slice(0, 400)}`);
        continue;
      }
      if (res.status === 404 || (res.status === 400 && /model|not found|does not exist|decommissioned|unsupported/i.test(detail))) {
        badModel[name + '|' + model] = true; // modello sbagliato: prova il prossimo dello stesso provider
        continue;
      }
      markFailure(name, res.status, detail);
      providerDown = true;
      break;
    }
    if (providerDown) continue;
  }
  const paused = order().filter(n => !usable(n));
  const detail = errors.length ? errors.join(' | ').slice(0, 400)
    : paused.length ? `provider in pausa dopo un errore di crediti/quota: ${paused.join(', ')} (riprovo tra pochi minuti)`
    : 'nessuna chiave LLM configurata (ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, ...)';
  console.error('[LLM] tutti i provider falliti:', detail);
  throw new LLMError('Nessun modello disponibile: ' + detail, { status: lastStatus || 503, detail, provider: 'none' });
}

const stripFences = (t) => String(t || '').replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

/**
 * complete({ system, messages, maxTokens, timeoutMs, json }) → { text, provider, model }
 * system: stringa o blocchi Anthropic; messages: [{role, content}] (content stringa o blocchi text/image)
 */
async function complete(opts) {
  const { name, model, res, kind } = await request(opts, false);
  const data = await res.json();
  let text = kind === 'anthropic'
    ? (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    : (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  if (typeof text !== 'string') text = String(text || '');
  if (opts.json) text = stripFences(text);
  return { text, provider: name, model };
}

/**
 * stream(opts) → { provider, model, tokens (async iterator di stringhe), cancel() }
 */
async function stream(opts) {
  const { name, model, res, kind } = await request(opts, true);
  async function* tokens() {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (kind === 'anthropic') {
          if (j.type === 'content_block_delta' && j.delta && j.delta.text) yield j.delta.text;
          else if (j.type === 'error') console.error('[LLM] stream error:', JSON.stringify(j.error || j).slice(0, 200));
        } else {
          const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (t) yield t;
          if (j.error) console.error('[LLM] stream error:', JSON.stringify(j.error).slice(0, 200));
        }
      }
    }
  }
  return { provider: name, model, tokens: tokens(), cancel: () => { try { res.body.cancel(); } catch (e) {} } };
}

module.exports = { complete, stream, available, configured, isFree, order, status, LLMError };
