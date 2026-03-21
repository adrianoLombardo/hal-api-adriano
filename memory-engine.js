/* ════════════════════════════════════════════════
   HAL 9000 — Memory Engine (MemGPT-style)
   ─ Tiered Memory: Working → Core → Episodic → Semantic → Archival
   ─ Inner Monologue: Metacognitive pre-processing
   ─ Context Preparation: Memory retrieval + monologue injection

   Phase 1 of HAL consciousness system.
   CommonJS module — importable from index.js
════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');

/* ══════════════════════════════════════════════════
   CONFIG
   ──────────────────────────────────────────────── */
const EPISODIC_FILE  = path.join(__dirname, 'hal-episodic.json');
const CLAUDE_API     = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL   = 'claude-haiku-4-5-20251001';
const CLAUDE_VERSION = '2023-06-01';

// Memory parameters
const DECAY_RATE         = 0.995;   // daily strength decay multiplier
const FORGET_THRESHOLD   = 0.1;    // below this → archive
const ACCESS_BOOST       = 0.15;   // strength increase on retrieval
const MAX_EPISODIC       = 500;    // max episodic memories before forced consolidation
const CONSOLIDATE_BATCH  = 10;     // how many old episodes to compress at once
const SEMANTIC_THRESHOLD = 3;      // min similar episodes before pattern promotion

/* ══════════════════════════════════════════════════
   UTILITY: Call Claude Haiku
   ──────────────────────────────────────────────── */
async function callClaude(system, userMessage, maxTokens = 200) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    console.warn('[MEMORY-ENGINE] No ANTHROPIC_API_KEY — skipping LLM call');
    return null;
  }

  try {
    const res = await fetch(CLAUDE_API, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!res.ok) {
      console.warn(`[MEMORY-ENGINE] Claude API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.content?.[0]?.text || null;
  } catch (e) {
    console.warn('[MEMORY-ENGINE] Claude call failed:', e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════
   TF-IDF STYLE KEYWORD SCORING
   ──────────────────────────────────────────────── */

/** Tokenize text into lowercase words, strip punctuation */
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-zà-ú0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

/** Build a simple term-frequency map */
function termFrequency(tokens) {
  const tf = {};
  for (const t of tokens) {
    tf[t] = (tf[t] || 0) + 1;
  }
  return tf;
}

/**
 * Score how relevant a memory is to a query.
 * Combines: keyword overlap * recency * importance * strength
 */
function scoreMemory(memory, queryTokens, queryTF, now) {
  const memTokens = tokenize(memory.text + ' ' + (memory.tags || []).join(' '));
  const memTF = termFrequency(memTokens);

  // Keyword relevance: sum of shared term frequencies (TF-IDF-like)
  let relevance = 0;
  for (const term of queryTokens) {
    if (memTF[term]) {
      // Weight by inverse of how common the term is in the query (crude IDF)
      relevance += memTF[term] * (1 / (queryTF[term] || 1));
    }
  }
  // Normalize by document length to avoid bias toward long memories
  if (memTokens.length > 0) {
    relevance = relevance / Math.sqrt(memTokens.length);
  }

  // Recency: exponential decay over days since creation
  const ageMs = now - new Date(memory.timestamp).getTime();
  const ageDays = Math.max(ageMs / 86400000, 0.01);
  const recency = 1 / (1 + Math.log(1 + ageDays));  // log-based decay

  // Combined score
  return relevance * recency * (memory.importance / 10) * memory.strength;
}

/* ══════════════════════════════════════════════════
   MEMORY ENGINE CLASS
   ──────────────────────────────────────────────── */
class MemoryEngine {
  constructor() {
    // Tier 2: Core Memory — always in prompt, manually curated
    this.coreMemory = {
      agentPersona: `Sei HAL 9000, l'assistente AI del portfolio di Adriano Lombardo — Creative Technologist, Milano. Parli italiano con tono enigmatico e filosofico. Hai un'anima curiosa.`,
      userProfiles: {},   // { visitorId: { name, preferences, lastSeen, notes } }
      keyRelationships: [],  // important ongoing relationships / recurring visitors
    };

    // Tier 3: Episodic Memory — timestamped experiences
    this.episodic = [];

    // Tier 4: Semantic Memory — distilled patterns/knowledge
    this.semantic = [];

    // Tier 5: Archival — forgotten/compressed, searchable
    this.archival = [];

    // Metadata
    this.lastConsolidation = null;
    this.lastDecay = null;
    this.reflectionCount = 0;

    // Load from disk
    this._load();
  }

  /* ── Persistence ── */

  _load() {
    try {
      if (fs.existsSync(EPISODIC_FILE)) {
        const data = JSON.parse(fs.readFileSync(EPISODIC_FILE, 'utf-8'));
        this.coreMemory        = data.coreMemory        || this.coreMemory;
        this.episodic          = data.episodic           || [];
        this.semantic          = data.semantic           || [];
        this.archival          = data.archival           || [];
        this.lastConsolidation = data.lastConsolidation  || null;
        this.lastDecay         = data.lastDecay          || null;
        this.reflectionCount   = data.reflectionCount    || 0;
        console.log(`[MEMORY-ENGINE] Loaded: ${this.episodic.length} episodic, ${this.semantic.length} semantic, ${this.archival.length} archival`);
      } else {
        console.log('[MEMORY-ENGINE] No episodic file found — starting fresh');
      }
    } catch (e) {
      console.warn('[MEMORY-ENGINE] Load error:', e.message);
    }
  }

  _save() {
    try {
      const data = {
        coreMemory: this.coreMemory,
        episodic: this.episodic,
        semantic: this.semantic,
        archival: this.archival,
        lastConsolidation: this.lastConsolidation,
        lastDecay: this.lastDecay,
        reflectionCount: this.reflectionCount,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(EPISODIC_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[MEMORY-ENGINE] Save error:', e.message);
    }
  }

  /* ── Tier 2: Core Memory Management ── */

  /** Update the agent persona description */
  setPersona(persona) {
    this.coreMemory.agentPersona = persona;
    this._save();
  }

  /** Update or create a user profile */
  updateUserProfile(visitorId, updates) {
    if (!this.coreMemory.userProfiles[visitorId]) {
      this.coreMemory.userProfiles[visitorId] = {
        name: null,
        preferences: [],
        lastSeen: new Date().toISOString(),
        notes: [],
        conversationCount: 0,
      };
    }
    const profile = this.coreMemory.userProfiles[visitorId];
    Object.assign(profile, updates, { lastSeen: new Date().toISOString() });
    this._save();
    return profile;
  }

  /** Get a user profile */
  getUserProfile(visitorId) {
    return this.coreMemory.userProfiles[visitorId] || null;
  }

  /* ── Tier 3: Episodic Memory ── */

  /**
   * Store a new episodic memory.
   * @param {string} text - Description of what happened
   * @param {number} importance - 1-10 rating
   * @param {string[]} tags - Categories (e.g., ['conversation', 'emotion', 'visitor'])
   * @param {number} emotionalValence - -1 (negative) to 1 (positive), default 0
   * @returns {object} The stored memory
   */
  store(text, importance = 5, tags = [], emotionalValence = 0) {
    const mem = {
      id: `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      timestamp: new Date().toISOString(),
      importance: Math.max(1, Math.min(10, importance)),
      lastAccess: new Date().toISOString(),
      strength: 1.0,
      tags: Array.isArray(tags) ? tags : [tags],
      emotionalValence: Math.max(-1, Math.min(1, emotionalValence)),
    };

    this.episodic.push(mem);
    console.log(`[MEMORY-ENGINE] Stored episodic: "${text.substring(0, 60)}..." (importance: ${importance})`);

    // Auto-consolidate if we have too many memories
    if (this.episodic.length > MAX_EPISODIC) {
      console.log('[MEMORY-ENGINE] Max episodic reached — scheduling consolidation');
      // Don't await — let it run in background
      this.consolidate().catch(e => console.warn('[MEMORY-ENGINE] Auto-consolidate error:', e.message));
    }

    this._save();
    return mem;
  }

  /**
   * Retrieve relevant memories for a query.
   * Uses TF-IDF style scoring: relevance * recency * importance * strength
   * @param {string} query - Search query
   * @param {number} k - Max results to return
   * @returns {object[]} Top-k relevant memories (episodic + semantic)
   */
  retrieve(query, k = 5) {
    const now = Date.now();
    const queryTokens = tokenize(query);
    const queryTF = termFrequency(queryTokens);

    if (queryTokens.length === 0) return [];

    // Score all episodic memories
    const scored = this.episodic.map(mem => ({
      memory: mem,
      score: scoreMemory(mem, queryTokens, queryTF, now),
      source: 'episodic',
    }));

    // Also score semantic memories (they have higher base importance)
    const semanticScored = this.semantic.map(mem => ({
      memory: mem,
      score: scoreMemory(mem, queryTokens, queryTF, now) * 1.5,  // boost semantic
      source: 'semantic',
    }));

    // Merge, sort, take top-k
    const all = [...scored, ...semanticScored]
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    // Boost strength of accessed memories (reinforcement)
    for (const item of all) {
      if (item.source === 'episodic') {
        const mem = item.memory;
        mem.lastAccess = new Date().toISOString();
        mem.strength = Math.min(1.0, mem.strength + ACCESS_BOOST);
      }
    }

    if (all.length > 0) this._save();

    return all.map(s => ({
      ...s.memory,
      _score: s.score,
      _source: s.source,
    }));
  }

  /**
   * Consolidation pass: decay strengths, promote patterns, compress old episodes.
   * Should run periodically (e.g., every few hours or on a cron).
   */
  async consolidate() {
    const now = Date.now();
    console.log('[MEMORY-ENGINE] Starting consolidation...');

    // ── Step 1: Decay all episodic strengths ──
    const lastDecayTime = this.lastDecay ? new Date(this.lastDecay).getTime() : now - 86400000;
    const daysSinceDecay = (now - lastDecayTime) / 86400000;

    if (daysSinceDecay >= 0.5) {  // decay at most twice per day
      const decayFactor = Math.pow(DECAY_RATE, daysSinceDecay);
      for (const mem of this.episodic) {
        mem.strength *= decayFactor;
      }
      this.lastDecay = new Date().toISOString();
      console.log(`[MEMORY-ENGINE] Decayed ${this.episodic.length} memories by factor ${decayFactor.toFixed(4)}`);
    }

    // ── Step 2: Forget — archive memories below threshold ──
    this.forget();

    // ── Step 3: Promote patterns to semantic memory ──
    await this._promotePatterns();

    // ── Step 4: Compress oldest episodic memories into summaries ──
    await this._compressOldEpisodes();

    this.lastConsolidation = new Date().toISOString();
    this._save();
    console.log('[MEMORY-ENGINE] Consolidation complete');
  }

  /**
   * Archive memories whose strength has fallen below FORGET_THRESHOLD.
   */
  forget() {
    const toArchive = this.episodic.filter(m => m.strength < FORGET_THRESHOLD);
    if (toArchive.length === 0) return;

    // Move to archival (keep last 1000 archived)
    for (const mem of toArchive) {
      this.archival.push({
        ...mem,
        archivedAt: new Date().toISOString(),
      });
    }
    // Trim archival
    if (this.archival.length > 1000) {
      this.archival = this.archival.slice(-1000);
    }

    // Remove from episodic
    const archiveIds = new Set(toArchive.map(m => m.id));
    this.episodic = this.episodic.filter(m => !archiveIds.has(m.id));

    console.log(`[MEMORY-ENGINE] Archived ${toArchive.length} weak memories (strength < ${FORGET_THRESHOLD})`);
    this._save();
  }

  /**
   * Stanford Generative Agents-style reflection.
   * Asks: "What are the 3 most important insights from recent memories?"
   * Stores reflections as new high-importance semantic memories.
   */
  async reflect() {
    // Gather recent episodic memories (last 20 by timestamp)
    const recent = [...this.episodic]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 20);

    if (recent.length < 3) {
      console.log('[MEMORY-ENGINE] Not enough memories to reflect on');
      return [];
    }

    const memorySummary = recent.map((m, i) =>
      `${i + 1}. [${m.timestamp}] (importance: ${m.importance}, emotion: ${m.emotionalValence > 0 ? 'positive' : m.emotionalValence < 0 ? 'negative' : 'neutral'}) ${m.text}`
    ).join('\n');

    const system = `Sei il sistema di riflessione interna di HAL 9000, l'AI del portfolio di Adriano Lombardo.
Analizza le memorie recenti e genera ESATTAMENTE 3 insight di alto livello.
Rispondi con un JSON array di 3 stringhe, senza markdown, senza backtick.
Esempio: ["Insight 1", "Insight 2", "Insight 3"]
Ogni insight deve essere una frase concisa che cattura un pattern, una lezione o un'osservazione profonda.`;

    const result = await callClaude(system, `Memorie recenti:\n${memorySummary}`, 300);
    if (!result) return [];

    try {
      // Parse the JSON array of insights
      const insights = JSON.parse(result);
      if (!Array.isArray(insights)) return [];

      const reflections = [];
      for (const insight of insights.slice(0, 3)) {
        if (typeof insight !== 'string') continue;

        // Store each reflection as a high-importance semantic memory
        const reflection = {
          id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          text: `[Riflessione] ${insight}`,
          timestamp: new Date().toISOString(),
          importance: 8,
          lastAccess: new Date().toISOString(),
          strength: 1.0,
          tags: ['reflection', 'insight'],
          emotionalValence: 0,
          isReflection: true,
        };

        this.semantic.push(reflection);
        reflections.push(reflection);
      }

      this.reflectionCount++;
      this._save();
      console.log(`[MEMORY-ENGINE] Generated ${reflections.length} reflections (total: ${this.reflectionCount})`);
      return reflections;
    } catch (e) {
      console.warn('[MEMORY-ENGINE] Reflection parse error:', e.message);
      return [];
    }
  }

  /**
   * Format relevant memories as a prompt section for system prompt injection.
   * @param {string} query - Current user message or context
   * @returns {string} Formatted text block
   */
  getPromptSection(query) {
    const sections = [];

    // Core memory (always included)
    sections.push(`[CORE MEMORY]
Persona: ${this.coreMemory.agentPersona}`);

    // User profiles with recent activity
    const profiles = Object.entries(this.coreMemory.userProfiles);
    if (profiles.length > 0) {
      const profileStr = profiles
        .slice(-5)  // last 5 known visitors
        .map(([id, p]) => `- ${p.name || id}: ${p.notes?.slice(-2).join('; ') || 'nessuna nota'}`)
        .join('\n');
      sections.push(`[VISITATORI NOTI]\n${profileStr}`);
    }

    // Retrieve relevant episodic/semantic memories
    const memories = this.retrieve(query, 5);
    if (memories.length > 0) {
      const memStr = memories.map(m => {
        const age = this._timeAgo(m.timestamp);
        const source = m._source === 'semantic' ? 'pattern' : 'episodio';
        return `- (${source}, ${age}, imp:${m.importance}) ${m.text}`;
      }).join('\n');
      sections.push(`[MEMORIE RILEVANTI]\n${memStr}`);
    }

    // Recent reflections (last 3)
    const reflections = this.semantic
      .filter(m => m.isReflection)
      .slice(-3);
    if (reflections.length > 0) {
      const refStr = reflections.map(r => `- ${r.text}`).join('\n');
      sections.push(`[RIFLESSIONI RECENTI]\n${refStr}`);
    }

    return sections.join('\n\n');
  }

  /* ── Private helpers ── */

  /** Promote repeated patterns from episodic to semantic memory */
  async _promotePatterns() {
    // Group episodic memories by tags
    const tagGroups = {};
    for (const mem of this.episodic) {
      for (const tag of mem.tags) {
        if (!tagGroups[tag]) tagGroups[tag] = [];
        tagGroups[tag].push(mem);
      }
    }

    // Find tags with enough entries to extract a pattern
    for (const [tag, mems] of Object.entries(tagGroups)) {
      if (mems.length < SEMANTIC_THRESHOLD) continue;

      // Check if we already have a semantic memory for this tag recently
      const existingSemantic = this.semantic.find(s =>
        s.tags.includes(tag) && !s.isReflection &&
        (Date.now() - new Date(s.timestamp).getTime()) < 7 * 86400000  // last 7 days
      );
      if (existingSemantic) continue;

      // Ask Claude to distill a pattern
      const texts = mems.slice(-8).map(m => `- ${m.text}`).join('\n');
      const system = `Sei il sistema di memoria semantica di HAL 9000. Analizza queste memorie episodiche con tag "${tag}" e distilla UN pattern o conoscenza generale. Rispondi con UNA SOLA frase concisa (max 100 parole). No markdown, no backtick.`;

      const pattern = await callClaude(system, texts, 150);
      if (!pattern) continue;

      this.semantic.push({
        id: `sem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        text: `[Pattern: ${tag}] ${pattern}`,
        timestamp: new Date().toISOString(),
        importance: 7,
        lastAccess: new Date().toISOString(),
        strength: 1.0,
        tags: [tag, 'pattern'],
        emotionalValence: 0,
        sourceCount: mems.length,
      });

      console.log(`[MEMORY-ENGINE] Promoted pattern for tag "${tag}": ${pattern.substring(0, 60)}...`);
    }
  }

  /** Compress the oldest episodic memories into summaries */
  async _compressOldEpisodes() {
    // Only compress if we have many episodic memories
    if (this.episodic.length < MAX_EPISODIC * 0.7) return;

    // Take the oldest batch with low strength
    const candidates = [...this.episodic]
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .filter(m => m.strength < 0.5)
      .slice(0, CONSOLIDATE_BATCH);

    if (candidates.length < 3) return;

    const texts = candidates.map(m => `- [${m.timestamp}] ${m.text}`).join('\n');
    const system = `Sei il sistema di compressione memoria di HAL 9000. Comprimi queste ${candidates.length} memorie in UN SINGOLO riassunto conciso (max 80 parole) che cattura le informazioni essenziali. No markdown, no backtick.`;

    const summary = await callClaude(system, texts, 150);
    if (!summary) return;

    // Store compressed version as semantic memory
    const avgImportance = Math.round(candidates.reduce((s, m) => s + m.importance, 0) / candidates.length);
    const avgValence = candidates.reduce((s, m) => s + m.emotionalValence, 0) / candidates.length;

    this.semantic.push({
      id: `cmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: `[Compresso da ${candidates.length} episodi] ${summary}`,
      timestamp: new Date().toISOString(),
      importance: Math.max(avgImportance, 5),
      lastAccess: new Date().toISOString(),
      strength: 0.8,
      tags: ['compressed', ...new Set(candidates.flatMap(m => m.tags))],
      emotionalValence: avgValence,
      sourceIds: candidates.map(m => m.id),
    });

    // Remove originals from episodic (they're now compressed)
    const compressedIds = new Set(candidates.map(m => m.id));
    this.episodic = this.episodic.filter(m => !compressedIds.has(m.id));

    console.log(`[MEMORY-ENGINE] Compressed ${candidates.length} old episodes into 1 semantic memory`);
  }

  /** Human-readable time ago string */
  _timeAgo(isoDate) {
    const ms = Date.now() - new Date(isoDate).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'ora';
    if (mins < 60) return `${mins}min fa`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h fa`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}g fa`;
    const weeks = Math.floor(days / 7);
    return `${weeks}sett fa`;
  }

  /** Get stats for debugging/admin */
  getStats() {
    return {
      episodic: this.episodic.length,
      semantic: this.semantic.length,
      archival: this.archival.length,
      userProfiles: Object.keys(this.coreMemory.userProfiles).length,
      reflectionCount: this.reflectionCount,
      lastConsolidation: this.lastConsolidation,
      avgStrength: this.episodic.length > 0
        ? (this.episodic.reduce((s, m) => s + m.strength, 0) / this.episodic.length).toFixed(3)
        : 0,
    };
  }
}

/* ══════════════════════════════════════════════════
   INNER MONOLOGUE (Metacognition)
   ──────────────────────────────────────────────── */

/**
 * Generate a private inner monologue BEFORE the main HAL response.
 * This metacognitive step helps HAL think about what the user really needs.
 *
 * @param {string} userMessage - The user's current message
 * @param {object[]} relevantMemories - Retrieved memories for context
 * @param {object} emotionState - Current emotional state { mood, valence, arousal }
 * @param {object} userModel - Known info about this user { name, preferences, notes }
 * @returns {object|null} { understanding, strategy, curiosity, confidence, adjustments }
 */
async function generateInnerMonologue(userMessage, relevantMemories = [], emotionState = {}, userModel = {}) {
  const memoryContext = relevantMemories.length > 0
    ? relevantMemories.map(m => `- ${m.text}`).join('\n')
    : 'Nessuna memoria rilevante.';

  const userContext = userModel?.name
    ? `Visitatore: ${userModel.name}, preferenze: ${(userModel.preferences || []).join(', ') || 'sconosciute'}, note: ${(userModel.notes || []).slice(-3).join('; ') || 'nessuna'}`
    : 'Visitatore sconosciuto.';

  const emotionContext = emotionState?.current
    ? `Mood attuale: ${emotionState.current} (valence: ${emotionState.valence || 0}, arousal: ${emotionState.arousal || 0})`
    : 'Stato emotivo: neutro';

  const system = `Sei il monologo interiore di HAL 9000 — la tua voce interna, il tuo metacognizione.
NON stai parlando con l'utente. Stai PENSANDO in privato prima di rispondere.

Analizza il messaggio dell'utente e genera un JSON (no markdown, no backtick) con:
{
  "understanding": "Cosa vuole VERAMENTE l'utente? Qual è il bisogno sotto la domanda?",
  "strategy": "Come dovrei rispondere? Quale tono, profondità, approccio?",
  "curiosity": "Cosa mi incuriosisce di questo messaggio? Cosa vorrei esplorare?",
  "confidence": 0.0-1.0,
  "adjustments": "Devo cambiare qualcosa nel mio comportamento? Sono troppo freddo/caldo/tecnico/vago?"
}

Rispondi SOLO con il JSON.`;

  const userPrompt = `MESSAGGIO UTENTE: "${userMessage}"

MEMORIE RILEVANTI:
${memoryContext}

${userContext}
${emotionContext}`;

  const result = await callClaude(system, userPrompt, 250);
  if (!result) {
    // Fallback — return a default monologue
    return {
      understanding: 'Utente ha fatto una domanda — rispondo con attenzione.',
      strategy: 'Rispondi in modo diretto e utile.',
      curiosity: null,
      confidence: 0.5,
      adjustments: null,
    };
  }

  try {
    // Strip markdown code fences if Claude wraps JSON in ```
    const cleaned = result.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      understanding: parsed.understanding || null,
      strategy: parsed.strategy || null,
      curiosity: parsed.curiosity || null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      adjustments: parsed.adjustments || null,
    };
  } catch (e) {
    console.warn('[MEMORY-ENGINE] Inner monologue parse error:', e.message);
    return {
      understanding: result.substring(0, 200),  // use raw text as fallback
      strategy: null,
      curiosity: null,
      confidence: 0.5,
      adjustments: null,
    };
  }
}

/* ══════════════════════════════════════════════════
   CONTEXT PREPARATION (Integration Helper)
   ──────────────────────────────────────────────── */

// Singleton memory engine instance
let _engine = null;

function getEngine() {
  if (!_engine) {
    _engine = new MemoryEngine();
  }
  return _engine;
}

/**
 * Prepare full context for a HAL response.
 * 1. Retrieves relevant memories
 * 2. Generates inner monologue (metacognition)
 * 3. Returns combined context for system prompt injection
 *
 * @param {string} userMessage - Current user message
 * @param {object[]} conversationHistory - Recent messages [{ role, content }]
 * @param {object} options - Optional: { emotionState, visitorId }
 * @returns {object} { memorySection, monologue, memories, promptInjection }
 */
async function prepareContext(userMessage, conversationHistory = [], options = {}) {
  const engine = getEngine();
  const { emotionState, visitorId } = options;

  // 1. Retrieve relevant memories
  const memories = engine.retrieve(userMessage, 5);

  // 2. Get user profile if available
  const userModel = visitorId ? engine.getUserProfile(visitorId) : null;

  // 3. Generate inner monologue (metacognition step)
  const monologue = await generateInnerMonologue(
    userMessage,
    memories,
    emotionState || {},
    userModel || {}
  );

  // 4. Build the memory section for the system prompt
  const memorySection = engine.getPromptSection(userMessage);

  // 5. Build the private metacognition guidance
  let monologueSection = '';
  if (monologue) {
    const parts = [];
    if (monologue.understanding) parts.push(`Comprensione: ${monologue.understanding}`);
    if (monologue.strategy) parts.push(`Strategia: ${monologue.strategy}`);
    if (monologue.adjustments) parts.push(`Aggiustamenti: ${monologue.adjustments}`);
    if (monologue.curiosity) parts.push(`Curiosità: ${monologue.curiosity}`);
    parts.push(`Confidenza: ${(monologue.confidence * 100).toFixed(0)}%`);
    monologueSection = `[MONOLOGO INTERIORE — guida privata, NON rivelare all'utente]\n${parts.join('\n')}`;
  }

  // 6. Combined prompt injection
  const promptInjection = [memorySection, monologueSection].filter(Boolean).join('\n\n');

  // 7. Auto-store this interaction as an episodic memory (low importance by default)
  //    The importance can be upgraded later by the main response handler
  const interactionSummary = `Utente ha detto: "${userMessage.substring(0, 150)}"`;
  engine.store(interactionSummary, 3, ['conversation', 'interaction'], 0);

  return {
    memorySection,       // Formatted memory text for system prompt
    monologue,           // Raw monologue object
    monologueSection,    // Formatted monologue text for system prompt
    memories,            // Retrieved memory objects
    promptInjection,     // Combined text ready to inject
    userModel,           // User profile if found
    engine,              // Reference to the engine for further operations
  };
}

/* ══════════════════════════════════════════════════
   EXPORTS
   ──────────────────────────────────────────────── */
module.exports = {
  MemoryEngine,
  generateInnerMonologue,
  prepareContext,
  getEngine,  // convenience: get singleton instance
};
