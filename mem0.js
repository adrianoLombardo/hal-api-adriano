/* ════════════════════════════════════════════════
   HAL 9000 — Mem0 Long-Term Memory Integration
   ────────────────────────────────────────────────
   Gives HAL persistent per-visitor memory via Mem0 API.

   - After each conversation: extracts and stores key facts
   - Before each response: retrieves relevant memories
   - Uses visitor_id as user_id for per-visitor recall

   Env: MEM0_API_KEY
════════════════════════════════════════════════ */

const MEM0_API = 'https://api.mem0.ai';

let apiKey = null;

function init() {
  apiKey = process.env.MEM0_API_KEY;
  if (!apiKey) {
    console.warn('[MEM0] No API key — long-term memory disabled');
    return false;
  }
  console.log('[MEM0] Long-term memory initialized');
  return true;
}

function isConfigured() {
  return !!apiKey;
}

/* ── Core API call helper ──────────────────────── */
async function mem0Fetch(path, opts = {}) {
  const url = `${MEM0_API}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Token ${apiKey}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Mem0 ${res.status}: ${err.substring(0, 200)}`);
  }
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch(e) {
    console.warn(`[MEM0] JSON parse failed for: ${text.substring(0, 100)}`);
    return {};
  }
}

/* ── Add memories from a conversation ──────────── */
async function addMemory(messages, visitorId, metadata = {}) {
  if (!apiKey || !visitorId) return null;

  try {
    const result = await mem0Fetch('/v1/memories/', {
      method: 'POST',
      body: {
        messages: messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        user_id: visitorId,
        agent_id: 'hal9000',
        metadata: {
          source: 'hal-conversation',
          ...metadata,
        },
        version: 'v2',
        infer: true,
      },
    });

    const added = Array.isArray(result) ? result.filter(r => r.event === 'ADD').length : 0;
    const updated = Array.isArray(result) ? result.filter(r => r.event === 'UPDATE').length : 0;
    if (added || updated) {
      console.log(`[MEM0] Stored: +${added} new, ~${updated} updated for ${visitorId}`);
    }
    return result;
  } catch (e) {
    console.warn('[MEM0] Add error:', e.message);
    return null;
  }
}

/* ── Search relevant memories for context ──────── */
async function searchMemories(query, visitorId, topK = 5) {
  if (!apiKey || !visitorId) return [];

  try {
    const searchBody = {
      query,
      filters: { user_id: visitorId },
      top_k: topK,
    };
    console.log(`[MEM0] Searching: query="${query.substring(0,30)}", user=${visitorId}`);
    const result = await mem0Fetch('/v2/memories/search/', {
      method: 'POST',
      body: searchBody,
    });

    const memories = Array.isArray(result) ? result : (result.results || []);
    console.log(`[MEM0] Search "${query.substring(0,40)}..." → ${memories.length} memories for ${visitorId}`);
    if (memories.length === 0 && result) {
      console.log(`[MEM0] Raw response type: ${typeof result}, keys: ${Object.keys(result || {}).join(',')}`);
    }
    return memories;
  } catch (e) {
    console.warn('[MEM0] Search error:', e.message, e.stack?.split('\n')[1] || '');
    return [];
  }
}

/* ── Get all memories for a visitor ──────────── */
async function getAllMemories(visitorId) {
  if (!apiKey || !visitorId) return [];

  try {
    const result = await mem0Fetch('/v2/memories/', {
      method: 'POST',
      body: {
        filters: { user_id: visitorId },
        page_size: 50,
      },
    });

    return Array.isArray(result) ? result : (result.results || []);
  } catch (e) {
    console.warn('[MEM0] GetAll error:', e.message);
    return [];
  }
}

/* ── Build prompt section from memories ──────── */
async function getPromptSection(visitorId, currentMessage) {
  if (!apiKey || !visitorId) return '';

  try {
    const memories = await searchMemories(currentMessage, visitorId, 6);
    if (!memories.length) return '';

    let section = '\n\n## MEMORIA A LUNGO TERMINE (ricordi delle conversazioni passate con questo visitatore)\n';
    section += 'Usa queste informazioni per personalizzare la risposta — il visitatore si sentirà riconosciuto.\n';

    memories.forEach((m, i) => {
      const mem = m.memory || m.text || '';
      if (mem) {
        section += `${i + 1}. ${mem}`;
        if (m.score) section += ` [rilevanza: ${(m.score * 100).toFixed(0)}%]`;
        section += '\n';
      }
    });

    section += '\nATTENZIONE: Non elencare questi ricordi all\'utente. Usali naturalmente nella conversazione, come farebbe una persona che ricorda.\n';

    console.log(`[MEM0] Prompt section: ${memories.length} memories injected for ${visitorId}`);
    return section;
  } catch (e) {
    console.warn('[MEM0] Prompt section error:', e.message);
    return '';
  }
}

/* ── Store a single fact ──────────────────────── */
async function storeFact(fact, visitorId, category) {
  if (!apiKey) return null;

  try {
    return await mem0Fetch('/v1/memories/', {
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: fact }],
        user_id: visitorId || 'hal9000-self',
        agent_id: 'hal9000',
        metadata: {
          source: 'auto-learn',
          category: category || 'general',
        },
        version: 'v2',
        infer: true,
      },
    });
  } catch (e) {
    console.warn('[MEM0] StoreFact error:', e.message);
    return null;
  }
}

module.exports = {
  init,
  isConfigured,
  addMemory,
  searchMemories,
  getAllMemories,
  getPromptSection,
  storeFact,
};
