/* ════════════════════════════════════════════════════════════════════
   HAL 9000 — Consciousness Orchestrator
   ─────────────────────────────────────────────────────────────────
   Ties together the three consciousness modules:
     - memory-engine.js   (episodic/semantic memory, inner monologue)
     - emotion-tom.js     (emotion state, user modeling, appraisal)
     - curiosity-bonding.js (curiosity drive, relationship tracking)

   Graceful degradation: if any module is missing or broken,
   the orchestrator still works with no-op stubs.

   Usage in index.js:
     const { HALConsciousness } = require('./consciousness');
     const halMind = new HALConsciousness();
   ════════════════════════════════════════════════════════════════════ */

/* ── Graceful imports with no-op fallbacks ──────────────────────── */

let MemoryEngine, generateInnerMonologue, prepareContext;
try {
  ({ MemoryEngine, generateInnerMonologue, prepareContext } = require('./memory-engine'));
  console.log('[CONSCIOUSNESS] memory-engine loaded');
} catch (e) {
  console.warn('[CONSCIOUSNESS] memory-engine not available:', e.message);
  MemoryEngine = class StubMemoryEngine {
    store() {}
    retrieve() { return []; }
    consolidate() {}
    getStats() { return { episodic: 0, semantic: 0, total: 0 }; }
    getPromptSection() { return ''; }
  };
  generateInnerMonologue = async () => null;
  prepareContext = () => '';
}

let EmotionEngine, UserModel, appraiseTurn;
try {
  ({ EmotionEngine, UserModel, appraiseTurn } = require('./emotion-tom'));
  console.log('[CONSCIOUSNESS] emotion-tom loaded');
} catch (e) {
  console.warn('[CONSCIOUSNESS] emotion-tom not available:', e.message);
  EmotionEngine = class StubEmotionEngine {
    update() {}
    decay() {}
    getEmotionLabel() { return 'curious'; }
    getPromptInfluence() { return ''; }
    get mood() { return { valence: 0.6, arousal: 0.4 }; }
    get personality() { return {}; }
  };
  UserModel = class StubUserModel {
    update() {}
    getAdaptationPrompt() { return ''; }
    getProfile() { return null; }
  };
  appraiseTurn = () => ({ emotion: 'neutral', intensity: 0 });
}

let CuriosityEngine, RelationshipTracker, enrichContext;
try {
  ({ CuriosityEngine, RelationshipTracker, enrichContext } = require('./curiosity-bonding'));
  console.log('[CONSCIOUSNESS] curiosity-bonding loaded');
} catch (e) {
  console.warn('[CONSCIOUSNESS] curiosity-bonding not available:', e.message);
  CuriosityEngine = class StubCuriosityEngine {
    onConversation() {}
    getTopCuriosities() { return []; }
    getPromptSection() { return ''; }
  };
  RelationshipTracker = class StubRelationshipTracker {
    onSessionStart() {}
    onSessionEnd() {}
    updateDisclosure() {}
    evolveStage() {}
    getPromptSection() { return ''; }
    get globalStats() { return { totalSessions: 0, uniqueVisitors: 0 }; }
  };
  enrichContext = () => '';
}


/* ══════════════════════════════════════════════════════════════════
   HALConsciousness — The Orchestrator
   ────────────────────────────────────────────────────────────────── */

class HALConsciousness {
  constructor() {
    this.memory = new MemoryEngine();
    this.emotion = new EmotionEngine();
    this.userModel = new UserModel();
    this.curiosity = new CuriosityEngine();
    this.relationships = new RelationshipTracker();

    // Periodic task handle (started on first use)
    this._periodicHandle = null;
    this._startPeriodicTasks();

    console.log('[CONSCIOUSNESS] HAL consciousness initialized');
  }

  /* ── beforeResponse ──────────────────────────────────────────
     Called BEFORE generating a Claude response.
     Gathers all context, generates inner monologue.
     Returns: { systemPromptAddition: string, innerMonologue: object|null }
     ─────────────────────────────────────────────────────────── */
  async beforeResponse(sessionId, userMessage, conversationHistory, sensorData = {}) {
    const parts = [];
    let innerMonologue = null;

    try {
      // 1. Retrieve relevant memories (sync, fast)
      const memories = this.memory.retrieve(userMessage, sessionId);
      if (memories && memories.length > 0) {
        const memSection = prepareContext(memories);
        if (memSection) parts.push(memSection);
      }
    } catch (e) {
      console.warn('[CONSCIOUSNESS] memory retrieve error:', e.message);
    }

    try {
      // 2. User model adaptation prompt
      const adaptPrompt = this.userModel.getAdaptationPrompt(sessionId);
      if (adaptPrompt) parts.push(adaptPrompt);
    } catch (e) {
      console.warn('[CONSCIOUSNESS] user model error:', e.message);
    }

    try {
      // 3. Relationship context
      const relPrompt = this.relationships.getPromptSection(sessionId);
      if (relPrompt) parts.push(relPrompt);
    } catch (e) {
      console.warn('[CONSCIOUSNESS] relationship error:', e.message);
    }

    try {
      // 4. Curiosity context
      const curPrompt = this.curiosity.getPromptSection();
      if (curPrompt) parts.push(curPrompt);
    } catch (e) {
      console.warn('[CONSCIOUSNESS] curiosity error:', e.message);
    }

    try {
      // 5. Enriched context from curiosity-bonding (combines multiple signals)
      const enriched = enrichContext({
        sessionId,
        userMessage,
        conversationHistory,
        sensorData,
        emotion: this.emotion,
        curiosity: this.curiosity,
        relationships: this.relationships,
      });
      if (enriched) parts.push(enriched);
    } catch (e) {
      console.warn('[CONSCIOUSNESS] enrichContext error:', e.message);
    }

    try {
      // 6. Inner monologue — the ONLY awaited call (it shapes the response)
      innerMonologue = await generateInnerMonologue({
        userMessage,
        conversationHistory,
        emotionState: this.emotion.getEmotionLabel(),
        memories: this.memory.retrieve(userMessage, sessionId),
        sensorData,
      });
    } catch (e) {
      console.warn('[CONSCIOUSNESS] inner monologue error:', e.message);
    }

    try {
      // 7. Emotion influence on tone
      const emotionPrompt = this.emotion.getPromptInfluence();
      if (emotionPrompt) parts.push(emotionPrompt);
    } catch (e) {
      console.warn('[CONSCIOUSNESS] emotion prompt error:', e.message);
    }

    // If inner monologue produced text, include it
    if (innerMonologue && innerMonologue.text) {
      parts.push(`\n### MONOLOGO INTERIORE (pensiero privato — non dirlo all'utente, lascia che guidi la tua risposta)\n${innerMonologue.text}`);
    }

    // Build combined system prompt addition
    const systemPromptAddition = parts.length > 0
      ? '\n\n## IL TUO STATO DI COSCIENZA\n' + parts.join('\n')
      : '';

    return { systemPromptAddition, innerMonologue };
  }

  /* ── afterResponse ───────────────────────────────────────────
     Called AFTER generating a response.
     All updates are fire-and-forget (non-blocking).
     ─────────────────────────────────────────────────────────── */
  async afterResponse(sessionId, userMessage, halResponse, sensorData = {}) {
    // 1. Store new episodic memory
    this._safeAsync(() =>
      this.memory.store({
        type: 'episodic',
        sessionId,
        userMessage,
        halResponse,
        timestamp: Date.now(),
        sensorData,
      })
    );

    // 2. Appraise the turn and update emotion state
    this._safeAsync(() => {
      const appraisal = appraiseTurn(userMessage, halResponse, sensorData);
      this.emotion.update(appraisal);
    });

    // 3. Update user model with new data
    this._safeAsync(() =>
      this.userModel.update(sessionId, {
        userMessage,
        halResponse,
        sensorData,
        timestamp: Date.now(),
      })
    );

    // 4. Update curiosity engine
    this._safeAsync(() =>
      this.curiosity.onConversation(userMessage, halResponse)
    );

    // 5. Update relationship tracker — track topic + disclosure
    this._safeAsync(() => {
      this.relationships.updateDisclosure(sessionId, userMessage);
      this.relationships.evolveStage(sessionId);
    });
  }

  /* ── onSessionStart ──────────────────────────────────────────
     Called when HAL overlay opens.
     Returns a greeting context string for personalization.
     ─────────────────────────────────────────────────────────── */
  onSessionStart(sessionId) {
    const contextParts = [];

    try {
      // Track visitor in relationship module
      this.relationships.onSessionStart(sessionId);
    } catch (e) {
      console.warn('[CONSCIOUSNESS] session start tracking error:', e.message);
    }

    try {
      // Get returning visitor info
      const profile = this.userModel.getProfile(sessionId);
      if (profile && profile.visitCount > 1) {
        contextParts.push(`Visitatore di ritorno (visita #${profile.visitCount}).`);
        if (profile.interests && profile.interests.length > 0) {
          contextParts.push(`Interessi precedenti: ${profile.interests.join(', ')}.`);
        }
        if (profile.lastVisit) {
          const daysSince = Math.floor((Date.now() - profile.lastVisit) / 86400000);
          if (daysSince > 0) {
            contextParts.push(`Ultima visita: ${daysSince} giorni fa.`);
          }
        }
      }
    } catch (e) {
      console.warn('[CONSCIOUSNESS] user profile error:', e.message);
    }

    try {
      // Get relationship-specific greeting hints
      const relPrompt = this.relationships.getPromptSection(sessionId);
      if (relPrompt) contextParts.push(relPrompt);
    } catch (e) {
      // silent — already logged above if relationship module is missing
    }

    try {
      // Get top curiosities to potentially ask about
      const curiosities = this.curiosity.getTopCuriosities(2);
      if (curiosities && curiosities.length > 0) {
        contextParts.push(`Curiosità attive: ${curiosities.map(c => c.topic || c).join(', ')}.`);
      }
    } catch (e) {
      // silent
    }

    return contextParts.length > 0
      ? contextParts.join(' ')
      : '';
  }

  /* ── onSessionEnd ────────────────────────────────────────────
     Called when HAL overlay closes.
     Finalizes session data and triggers consolidation if needed.
     ─────────────────────────────────────────────────────────── */
  onSessionEnd(sessionId, durationSeconds, messageCount) {
    try {
      this.relationships.onSessionEnd(sessionId, durationSeconds, messageCount);
    } catch (e) {
      console.warn('[CONSCIOUSNESS] session end tracking error:', e.message);
    }

    // Trigger memory consolidation for longer sessions
    if (messageCount >= 5) {
      this._safeAsync(() => this.memory.consolidate(sessionId));
    }

    console.log(`[CONSCIOUSNESS] Session ${sessionId} ended — ${durationSeconds}s, ${messageCount} messages`);
  }

  /* ── periodicTasks ───────────────────────────────────────────
     Background maintenance: memory consolidation, emotion decay,
     reflection generation. Called every 30 minutes.
     ─────────────────────────────────────────────────────────── */
  async periodicTasks() {
    console.log('[CONSCIOUSNESS] Running periodic tasks...');

    // Memory consolidation (promote important episodic → semantic)
    this._safeAsync(() => this.memory.consolidate());

    // Emotion decay (mood drifts toward baseline over time)
    this._safeAsync(() => this.emotion.decay());

    console.log('[CONSCIOUSNESS] Periodic tasks complete');
  }

  /* ── getState ────────────────────────────────────────────────
     Returns full consciousness state snapshot for admin/debug.
     ─────────────────────────────────────────────────────────── */
  getState() {
    let state = {};

    try {
      state.emotion = this.emotion.getEmotionLabel();
    } catch (e) {
      state.emotion = 'unknown';
    }

    try {
      state.mood = this.emotion.mood;
    } catch (e) {
      state.mood = null;
    }

    try {
      state.personality = this.emotion.personality;
    } catch (e) {
      state.personality = null;
    }

    try {
      state.totalMemories = this.memory.getStats();
    } catch (e) {
      state.totalMemories = { episodic: 0, semantic: 0, total: 0 };
    }

    try {
      state.topCuriosities = this.curiosity.getTopCuriosities(3);
    } catch (e) {
      state.topCuriosities = [];
    }

    try {
      state.relationshipStats = this.relationships.globalStats;
    } catch (e) {
      state.relationshipStats = {};
    }

    return state;
  }

  /* ── buildPromptSection ──────────────────────────────────────
     Builds the consciousness block for the system prompt.
     Lightweight version of beforeResponse — no async, no monologue.
     Useful for quick prompt augmentation without full pipeline.
     ─────────────────────────────────────────────────────────── */
  buildPromptSection(sessionId) {
    let prompt = '\n\n## IL TUO STATO DI COSCIENZA\n';

    try {
      const emotionPart = this.emotion.getPromptInfluence();
      if (emotionPart) prompt += emotionPart + '\n';
    } catch (e) { /* stub returns '' */ }

    try {
      const curiosityPart = this.curiosity.getPromptSection();
      if (curiosityPart) prompt += curiosityPart + '\n';
    } catch (e) { /* stub returns '' */ }

    try {
      const relPart = this.relationships.getPromptSection(sessionId);
      if (relPart) prompt += relPart + '\n';
    } catch (e) { /* stub returns '' */ }

    try {
      const adaptPart = this.userModel.getAdaptationPrompt(sessionId);
      if (adaptPart) prompt += adaptPart + '\n';
    } catch (e) { /* stub returns '' */ }

    return prompt;
  }

  /* ── Internal helpers ────────────────────────────────────────── */

  /**
   * Fire-and-forget async wrapper. Catches and logs errors
   * so they never crash the server or block the response.
   */
  _safeAsync(fn) {
    try {
      const result = fn();
      // If fn returns a promise, catch its rejection
      if (result && typeof result.catch === 'function') {
        result.catch(e => console.warn('[CONSCIOUSNESS] async error:', e.message));
      }
    } catch (e) {
      console.warn('[CONSCIOUSNESS] sync error:', e.message);
    }
  }

  /**
   * Start the periodic task interval (every 30 minutes).
   */
  _startPeriodicTasks() {
    if (this._periodicHandle) return;
    const THIRTY_MINUTES = 30 * 60 * 1000;
    this._periodicHandle = setInterval(() => {
      this.periodicTasks();
    }, THIRTY_MINUTES);

    // Don't let the interval keep Node alive if the server is shutting down
    if (this._periodicHandle.unref) {
      this._periodicHandle.unref();
    }
  }

  /**
   * Stop periodic tasks (for graceful shutdown).
   */
  destroy() {
    if (this._periodicHandle) {
      clearInterval(this._periodicHandle);
      this._periodicHandle = null;
    }
    console.log('[CONSCIOUSNESS] Orchestrator destroyed');
  }
}


/* ══════════════════════════════════════════════════════════════════
   Export
   ────────────────────────────────────────────────────────────────── */

module.exports = { HALConsciousness };
