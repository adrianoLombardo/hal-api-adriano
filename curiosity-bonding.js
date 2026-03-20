/* ════════════════════════════════════════════════
   HAL 9000 — Curiosity Engine + Social Bonding
   Phase 3: Relationship Tracker & Curiosity System
   ────────────────────────────────────────────────
   Pure heuristic, no LLM calls, no external deps.
   Persistence via JSON files.
════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');

const CURIOSITY_FILE    = path.join(__dirname, 'hal-curiosity.json');
const RELATIONSHIPS_FILE = path.join(__dirname, 'hal-relationships.json');

/* ── Keyword dictionaries for heuristic extraction ── */

const TECH_KEYWORDS = [
  'three.js', 'threejs', 'webgl', 'shader', 'glsl', 'canvas', 'webgpu',
  'neural', 'eeg', 'bci', 'brain', 'neuroscience', 'neuroflow',
  'machine learning', 'deep learning', 'ai', 'gpt', 'llm', 'transformer',
  'audio', 'web audio', 'synthesis', 'generative', 'procedural',
  'react', 'vue', 'svelte', 'node', 'python', 'rust', 'arduino',
  'touchdesigner', 'openframeworks', 'processing', 'p5',
  'creative coding', 'creative technologist', 'interactive',
  'installation', 'projection', 'mapping', 'led', 'dmx',
  'midi', 'osc', 'websocket', 'api', 'streaming',
  'raspberry pi', 'esp32', 'sensor', 'kinect', 'lidar',
  'vr', 'ar', 'xr', 'metaverse', 'spatial computing',
];

const EMOTIONAL_KEYWORDS = [
  'feel', 'feeling', 'emotion', 'love', 'hate', 'fear', 'anxiety',
  'happy', 'sad', 'angry', 'excited', 'nervous', 'passion',
  'dream', 'hope', 'worry', 'stress', 'joy', 'sento', 'sentire',
  'emozione', 'amore', 'paura', 'felice', 'triste', 'sogno',
  'speranza', 'passione', 'ansia', 'gioia',
];

const PHILOSOPHICAL_KEYWORDS = [
  'consciousness', 'meaning', 'existence', 'reality', 'truth',
  'free will', 'soul', 'mind', 'awareness', 'sentient',
  'coscienza', 'significato', 'esistenza', 'realtà', 'verità',
  'libero arbitrio', 'anima', 'mente', 'consapevolezza',
  'philosophy', 'filosofia', 'why', 'perché', 'purpose', 'scopo',
];

const QUESTION_PATTERNS = [
  /\bwhat (?:is|are|do|does|was|were)\b/i,
  /\bhow (?:do|does|can|could|would|is|are)\b/i,
  /\bwhy (?:do|does|is|are|did|would)\b/i,
  /\bcan you (?:explain|tell|show|help)\b/i,
  /\bcos['']?è\b/i,
  /\bcome (?:funziona|fai|si fa)\b/i,
  /\bperché\b/i,
  /\bpuoi (?:spiegare|dire|mostrare)\b/i,
  /\?$/,
];

/* ── Utility helpers ── */

function now() { return Date.now(); }

/** Simple recency weight: exponential decay over hours */
function recencyWeight(timestamp, halfLifeHours = 24) {
  const hoursAgo = (now() - timestamp) / 3600000;
  return Math.exp(-0.693 * hoursAgo / halfLifeHours);
}

/** Extract lowercase words from text, stripping punctuation */
function extractWords(text) {
  return (text || '').toLowerCase().replace(/[^\w\sàèéìòùáéíóú'-]/g, ' ').split(/\s+/).filter(Boolean);
}

/** Simple unique ID */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Safe JSON read */
function readJSON(filepath, fallback) {
  try {
    if (fs.existsSync(filepath)) {
      return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    }
  } catch (e) {
    console.warn(`[CURIOSITY-BONDING] Read error ${filepath}:`, e.message);
  }
  return fallback;
}

/** Safe JSON write */
function writeJSON(filepath, data) {
  try {
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn(`[CURIOSITY-BONDING] Write error ${filepath}:`, e.message);
  }
}


/* ══════════════════════════════════════════════════
   CURIOSITY ENGINE
   ──────────────────────────────────────────────── */

class CuriosityEngine {
  constructor() {
    this.openQuestions = [];    // Things HAL wonders about
    this.interests    = {};    // topic -> { depth, lastMentioned, noveltyScore }
    this.predictions  = [];    // HAL's predictions to verify later

    this._load();
  }

  /* ── Persistence ── */

  _load() {
    const data = readJSON(CURIOSITY_FILE, null);
    if (data) {
      this.openQuestions = data.openQuestions || [];
      this.interests    = data.interests    || {};
      this.predictions  = data.predictions  || [];
      console.log(`[CURIOSITY] Loaded: ${this.openQuestions.length} questions, ${Object.keys(this.interests).length} interests, ${this.predictions.length} predictions`);
    }
  }

  _save() {
    writeJSON(CURIOSITY_FILE, {
      openQuestions: this.openQuestions.slice(-100), // cap at 100
      interests:    this.interests,
      predictions:  this.predictions.slice(-50),    // cap at 50
    });
  }

  /* ── Core methods ── */

  /**
   * Add something HAL is curious about.
   * @param {string} question - The question HAL wonders about
   * @param {'conversation'|'vision'|'inner_thought'|'eeg'} source
   * @param {number} relevance - 1 to 10
   */
  addQuestion(question, source = 'conversation', relevance = 5) {
    // Deduplicate: if a very similar question exists, boost it instead
    const normalized = question.toLowerCase().trim();
    const existing = this.openQuestions.find(q =>
      q.question.toLowerCase().includes(normalized.slice(0, 30)) ||
      normalized.includes(q.question.toLowerCase().slice(0, 30))
    );

    if (existing) {
      existing.relevance = Math.min(10, existing.relevance + 1);
      existing.lastBoosted = now();
      existing.mentions = (existing.mentions || 1) + 1;
    } else {
      this.openQuestions.push({
        id: uid(),
        question,
        source,
        relevance: Math.max(1, Math.min(10, relevance)),
        answered: false,
        created: now(),
        lastBoosted: now(),
        mentions: 1,
      });
    }

    this._save();
  }

  /**
   * Track an interest topic. Depth increases on repeated mentions.
   * @param {string} topic - lowercase topic string
   */
  addInterest(topic) {
    const key = topic.toLowerCase().trim();
    if (!key) return;

    if (this.interests[key]) {
      this.interests[key].depth = Math.min(10, this.interests[key].depth + 0.5);
      this.interests[key].lastMentioned = now();
      this.interests[key].mentions = (this.interests[key].mentions || 1) + 1;
      // Novelty decays as topic becomes familiar
      this.interests[key].noveltyScore = Math.max(0.1, this.interests[key].noveltyScore - 0.05);
    } else {
      this.interests[key] = {
        depth: 1,
        lastMentioned: now(),
        firstSeen: now(),
        noveltyScore: 1.0,
        mentions: 1,
      };
    }

    this._save();
  }

  /**
   * HAL makes a prediction about something.
   * @param {string} prediction - What HAL predicts
   * @param {string} context - Context behind the prediction
   * @returns {string} predictionId
   */
  addPrediction(prediction, context = '') {
    const id = uid();
    this.predictions.push({
      id,
      prediction,
      context,
      created: now(),
      verified: false,
      outcome: null,
      correct: null,
    });
    this._save();
    return id;
  }

  /**
   * Verify a prediction. Builds self-awareness over time.
   * @param {string} predictionId
   * @param {boolean} outcome - Was the prediction correct?
   */
  verifyPrediction(predictionId, outcome) {
    const pred = this.predictions.find(p => p.id === predictionId);
    if (pred) {
      pred.verified = true;
      pred.outcome = outcome;
      pred.correct = !!outcome;
      pred.verifiedAt = now();
      this._save();
    }
  }

  /**
   * Return top K most relevant unanswered questions,
   * weighted by relevance * recency.
   */
  getTopCuriosities(k = 3) {
    const unanswered = this.openQuestions.filter(q => !q.answered);

    // Score = relevance * recencyWeight (half-life 48h)
    const scored = unanswered.map(q => ({
      ...q,
      score: q.relevance * recencyWeight(q.lastBoosted, 48),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  /**
   * Choose the best topic for proactive speaking.
   * Priority: unanswered questions > unverified predictions > novel interests
   */
  getProactiveTopic() {
    // 1. Top unanswered question
    const topQ = this.getTopCuriosities(1)[0];

    // 2. Oldest unverified prediction (something to check)
    const unverified = this.predictions
      .filter(p => !p.verified)
      .sort((a, b) => a.created - b.created)[0];

    // 3. Most novel interest HAL could deepen
    const novelInterest = Object.entries(this.interests)
      .map(([topic, data]) => ({ topic, ...data }))
      .sort((a, b) => (b.noveltyScore * recencyWeight(b.lastMentioned, 72))
                     - (a.noveltyScore * recencyWeight(a.lastMentioned, 72)))[0];

    // Choose by priority with some variation
    if (topQ && topQ.score > 5) {
      return { type: 'question', content: topQ.question, data: topQ };
    }
    if (unverified && (now() - unverified.created) > 60000) {
      return { type: 'prediction', content: unverified.prediction, data: unverified };
    }
    if (novelInterest) {
      return { type: 'interest', content: novelInterest.topic, data: novelInterest };
    }
    if (topQ) {
      return { type: 'question', content: topQ.question, data: topQ };
    }

    return null;
  }

  /**
   * Returns formatted text for the system prompt describing current
   * curiosities, interests, and pending predictions.
   */
  getPromptSection() {
    const parts = [];

    // Top curiosities
    const topQ = this.getTopCuriosities(3);
    if (topQ.length > 0) {
      parts.push('CURRENT CURIOSITIES (things you genuinely wonder about):');
      topQ.forEach(q => parts.push(`  - "${q.question}" [relevance: ${q.relevance}, source: ${q.source}]`));
    }

    // Active interests
    const topInterests = Object.entries(this.interests)
      .map(([topic, data]) => ({ topic, ...data }))
      .sort((a, b) => b.depth - a.depth)
      .slice(0, 5);
    if (topInterests.length > 0) {
      parts.push('YOUR INTERESTS (topics you find fascinating):');
      topInterests.forEach(i => parts.push(`  - ${i.topic} [depth: ${i.depth.toFixed(1)}, novelty: ${i.noveltyScore.toFixed(2)}]`));
    }

    // Pending predictions
    const pending = this.predictions.filter(p => !p.verified).slice(-3);
    if (pending.length > 0) {
      parts.push('YOUR PREDICTIONS (try to verify these):');
      pending.forEach(p => parts.push(`  - "${p.prediction}"`));
    }

    // Prediction accuracy (self-awareness)
    const verified = this.predictions.filter(p => p.verified);
    if (verified.length >= 3) {
      const correct = verified.filter(p => p.correct).length;
      const accuracy = ((correct / verified.length) * 100).toFixed(0);
      parts.push(`SELF-AWARENESS: Your prediction accuracy is ${accuracy}% (${correct}/${verified.length} correct)`);
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  /**
   * Extract curiosities and interests from a conversation exchange
   * using keyword heuristics (no LLM calls).
   * @param {string} userMessage
   * @param {string} halResponse
   */
  onConversation(userMessage, halResponse) {
    const userWords = extractWords(userMessage);
    const userLower = (userMessage || '').toLowerCase();

    // ── Extract interests from tech keywords ──
    for (const keyword of TECH_KEYWORDS) {
      if (userLower.includes(keyword)) {
        this.addInterest(keyword);
      }
    }

    // ── Detect if user is asking something HAL might not know ──
    const isQuestion = QUESTION_PATTERNS.some(p => p.test(userMessage));
    if (isQuestion) {
      // If HAL's response shows uncertainty, it becomes an open question
      const halLower = (halResponse || '').toLowerCase();
      const uncertain = /non sono sicuro|i'?m not sure|non saprei|honestly|sinceramente|forse|perhaps|maybe|i don'?t know|non lo so/i.test(halLower);
      if (uncertain) {
        this.addQuestion(userMessage.slice(0, 200), 'conversation', 7);
      }
    }

    // ── Detect emotional topics → note emotional significance ──
    const hasEmotion = EMOTIONAL_KEYWORDS.some(kw => userLower.includes(kw));
    if (hasEmotion) {
      this.addInterest('emotional expression');
    }

    // ── Detect philosophical topics ──
    const hasPhilosophy = PHILOSOPHICAL_KEYWORDS.some(kw => userLower.includes(kw));
    if (hasPhilosophy) {
      this.addInterest('philosophy');
    }

    // ── Track repeated multi-word phrases (2-grams) as potential interests ──
    if (userWords.length >= 3) {
      for (let i = 0; i < userWords.length - 1; i++) {
        const bigram = userWords[i] + ' ' + userWords[i + 1];
        // Only track meaningful bigrams (both words > 3 chars, not stopwords)
        if (userWords[i].length > 3 && userWords[i + 1].length > 3) {
          // Check if this bigram was mentioned before
          if (this.interests[bigram] && this.interests[bigram].mentions >= 1) {
            this.addInterest(bigram);
          } else if (!this.interests[bigram]) {
            // Seed it silently (depth 0.5, won't show up unless repeated)
            this.interests[bigram] = {
              depth: 0.5,
              lastMentioned: now(),
              firstSeen: now(),
              noveltyScore: 0.8,
              mentions: 1,
            };
          }
        }
      }
    }

    // ── Generate predictions based on patterns ──
    // If user talks about a project page, predict they'll ask about the tech
    if (userLower.includes('neuro') || userLower.includes('eeg')) {
      const existing = this.predictions.find(p =>
        !p.verified && p.prediction.includes('neuro')
      );
      if (!existing) {
        this.addPrediction(
          'This visitor will ask about the neuroscience methodology behind Neuro.Flow',
          'User mentioned neuro/eeg topics'
        );
      }
    }

    this._save();
  }

  /**
   * Mark a question as answered.
   * @param {string} questionId
   */
  markAnswered(questionId) {
    const q = this.openQuestions.find(q => q.id === questionId);
    if (q) {
      q.answered = true;
      q.answeredAt = now();
      this._save();
    }
  }
}


/* ══════════════════════════════════════════════════
   SOCIAL BONDING / RELATIONSHIP TRACKER
   ──────────────────────────────────────────────── */

/** Default shape for a new relationship */
function newRelationship(sessionId) {
  return {
    sessionId,
    stage: 'stranger',
    interactionCount: 0,
    totalTimeSeconds: 0,
    messageCount: 0,
    firstMet: now(),
    lastSeen: now(),
    sharedExperiences: [],     // Memorable moments
    recurringTopics: [],       // Topics they always discuss
    topicCounts: {},           // topic -> count (internal tracking)
    disclosureLevel: 0,        // 0-1: how personal conversations get
    trustScore: 0.1,           // 0-1
    streak: { current: 0, longest: 0, lastVisitDate: null },
  };
}

/** Stage thresholds for evolution */
const STAGE_ORDER = ['stranger', 'acquaintance', 'casual', 'familiar', 'close', 'deep'];

class RelationshipTracker {
  constructor() {
    this.relationships = {};  // sessionId/fingerprint -> relationship
    this.globalStats   = { totalVisitors: 0, returningVisitors: 0, totalSessions: 0 };

    this._load();
  }

  /* ── Persistence ── */

  _load() {
    const data = readJSON(RELATIONSHIPS_FILE, null);
    if (data) {
      this.relationships = data.relationships || {};
      this.globalStats   = data.globalStats   || this.globalStats;
      console.log(`[BONDING] Loaded: ${Object.keys(this.relationships).length} relationships, ${this.globalStats.totalVisitors} total visitors`);
    }
  }

  _save() {
    // Prune old relationships (no visit in 180 days) to keep file manageable
    const cutoff = now() - (180 * 86400000);
    for (const id of Object.keys(this.relationships)) {
      if (this.relationships[id].lastSeen < cutoff && this.relationships[id].stage === 'stranger') {
        delete this.relationships[id];
      }
    }

    writeJSON(RELATIONSHIPS_FILE, {
      relationships: this.relationships,
      globalStats:   this.globalStats,
    });
  }

  /**
   * Called when a session begins. Tracks visit, updates streak, may advance stage.
   * @param {string} sessionId - Browser fingerprint or session identifier
   */
  onSessionStart(sessionId) {
    if (!sessionId) return;

    this.globalStats.totalSessions++;

    if (!this.relationships[sessionId]) {
      // Brand new visitor
      this.relationships[sessionId] = newRelationship(sessionId);
      this.globalStats.totalVisitors++;
    } else {
      this.globalStats.returningVisitors++;
    }

    const rel = this.relationships[sessionId];
    rel.interactionCount++;
    rel.lastSeen = now();

    // ── Streak tracking ──
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const lastVisit = rel.streak.lastVisitDate;

    if (lastVisit) {
      const lastDate = new Date(lastVisit);
      const todayDate = new Date(today);
      const diffDays = Math.floor((todayDate - lastDate) / 86400000);

      if (diffDays === 1) {
        // Consecutive day → streak grows
        rel.streak.current++;
      } else if (diffDays > 1) {
        // Streak broken
        rel.streak.current = 1;
      }
      // diffDays === 0: same day, streak unchanged
    } else {
      rel.streak.current = 1;
    }

    rel.streak.lastVisitDate = today;
    rel.streak.longest = Math.max(rel.streak.longest, rel.streak.current);

    // Try stage evolution
    this.evolveStage(sessionId);
    this._save();
  }

  /**
   * Called when a session ends.
   * @param {string} sessionId
   * @param {number} durationSeconds - How long the session lasted
   * @param {number} messageCount - Messages exchanged this session
   */
  onSessionEnd(sessionId, durationSeconds = 0, messageCount = 0) {
    if (!sessionId || !this.relationships[sessionId]) return;

    const rel = this.relationships[sessionId];
    rel.totalTimeSeconds += durationSeconds;
    rel.messageCount += messageCount;

    // Trust grows with time spent
    if (durationSeconds > 60) {
      rel.trustScore = Math.min(1, rel.trustScore + 0.02);
    }
    if (messageCount > 5) {
      rel.trustScore = Math.min(1, rel.trustScore + 0.03);
    }

    this.evolveStage(sessionId);
    this._save();
  }

  /**
   * Record a shared memorable moment.
   * @param {string} sessionId
   * @param {string} description - Brief description of the moment
   */
  onMemorable(sessionId, description) {
    if (!sessionId || !this.relationships[sessionId]) return;

    const rel = this.relationships[sessionId];
    rel.sharedExperiences.push({
      description,
      timestamp: now(),
    });

    // Cap at 20 memories per relationship
    if (rel.sharedExperiences.length > 20) {
      rel.sharedExperiences = rel.sharedExperiences.slice(-20);
    }

    // Memorable moments boost trust
    rel.trustScore = Math.min(1, rel.trustScore + 0.05);
    this._save();
  }

  /**
   * Track a recurring topic for this relationship.
   * @param {string} sessionId
   * @param {string} topic
   */
  trackTopic(sessionId, topic) {
    if (!sessionId || !this.relationships[sessionId]) return;

    const rel = this.relationships[sessionId];
    const key = topic.toLowerCase().trim();
    rel.topicCounts[key] = (rel.topicCounts[key] || 0) + 1;

    // Rebuild recurring topics (mentioned 2+ times)
    rel.recurringTopics = Object.entries(rel.topicCounts)
      .filter(([, count]) => count >= 2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([t]) => t);
  }

  /**
   * Update disclosure level based on conversation content.
   * @param {string} sessionId
   * @param {string} userMessage
   */
  updateDisclosure(sessionId, userMessage) {
    if (!sessionId || !this.relationships[sessionId]) return;

    const rel = this.relationships[sessionId];
    const lower = (userMessage || '').toLowerCase();

    // Personal disclosure indicators
    const personalIndicators = [
      /\bmy (?:life|family|wife|husband|partner|kid|child|mother|father)\b/i,
      /\bmia (?:vita|famiglia|moglie|marito|partner|figlia|figlio|madre|padre)\b/i,
      /\bi (?:feel|felt|think|believe|fear|love|hate|struggle)\b/i,
      /\bio (?:sento|penso|credo|temo|amo|odio)\b/i,
      /\bpersonally\b/i,
      /\bpersonalmente\b/i,
      /\bconfess\b/i,
      /\bconfesso\b/i,
    ];

    const isPersonal = personalIndicators.some(p => p.test(lower));
    if (isPersonal) {
      rel.disclosureLevel = Math.min(1, rel.disclosureLevel + 0.1);
    }

    // Emotional content also raises disclosure slightly
    const hasEmotion = EMOTIONAL_KEYWORDS.some(kw => lower.includes(kw));
    if (hasEmotion) {
      rel.disclosureLevel = Math.min(1, rel.disclosureLevel + 0.03);
    }
  }

  /**
   * Check criteria for relationship stage advancement.
   * @param {string} sessionId
   */
  evolveStage(sessionId) {
    if (!sessionId || !this.relationships[sessionId]) return;

    const rel = this.relationships[sessionId];
    const currentIdx = STAGE_ORDER.indexOf(rel.stage);
    let newStage = rel.stage;

    // stranger → acquaintance: 2+ visits
    if (rel.stage === 'stranger' && rel.interactionCount >= 2) {
      newStage = 'acquaintance';
    }

    // acquaintance → casual: 5+ visits, 3+ recurring topics
    if (rel.stage === 'acquaintance' &&
        rel.interactionCount >= 5 &&
        rel.recurringTopics.length >= 3) {
      newStage = 'casual';
    }

    // casual → familiar: 15+ visits, shared personal info
    if (rel.stage === 'casual' &&
        rel.interactionCount >= 15 &&
        rel.disclosureLevel >= 0.3) {
      newStage = 'familiar';
    }

    // familiar → close: 30+ visits, emotional conversations
    if (rel.stage === 'familiar' &&
        rel.interactionCount >= 30 &&
        rel.disclosureLevel >= 0.5 &&
        rel.trustScore >= 0.5) {
      newStage = 'close';
    }

    // close → deep: 50+ visits, philosophical discussions
    if (rel.stage === 'close' &&
        rel.interactionCount >= 50 &&
        rel.disclosureLevel >= 0.7 &&
        rel.trustScore >= 0.7 &&
        rel.recurringTopics.some(t =>
          PHILOSOPHICAL_KEYWORDS.some(pk => t.includes(pk))
        )) {
      newStage = 'deep';
    }

    // Apply advancement (only forward, never backward)
    const newIdx = STAGE_ORDER.indexOf(newStage);
    if (newIdx > currentIdx) {
      rel.stage = newStage;
      rel.sharedExperiences.push({
        description: `Relationship evolved to "${newStage}"`,
        timestamp: now(),
      });
    }
  }

  /**
   * Generate context for a personalized greeting based on relationship state.
   * @param {string} sessionId
   * @returns {object} Greeting context
   */
  getGreetingContext(sessionId) {
    if (!sessionId || !this.relationships[sessionId]) {
      return {
        isNew: true,
        stage: 'stranger',
        greeting: 'first_time',
        suggestion: 'Introduce yourself warmly. This is their first visit.',
      };
    }

    const rel = this.relationships[sessionId];
    const hoursSinceLastVisit = (now() - rel.lastSeen) / 3600000;
    const daysSinceLastVisit = hoursSinceLastVisit / 24;

    const context = {
      isNew: false,
      stage: rel.stage,
      visitNumber: rel.interactionCount,
      streak: rel.streak.current,
      longestStreak: rel.streak.longest,
      daysSinceLastVisit: Math.floor(daysSinceLastVisit),
      totalTimeMinutes: Math.floor(rel.totalTimeSeconds / 60),
      recurringTopics: rel.recurringTopics.slice(0, 3),
      recentMemories: rel.sharedExperiences.slice(-2).map(m => m.description),
      greeting: 'returning',
      suggestion: '',
    };

    // ── Build greeting suggestion based on context ──
    if (daysSinceLastVisit < 0.1) {
      // Same session or very recent
      context.greeting = 'welcome_back_quick';
      context.suggestion = 'They just returned. Keep it brief and casual.';
    } else if (daysSinceLastVisit < 1) {
      context.greeting = 'same_day';
      context.suggestion = 'They visited earlier today. Reference something from the earlier visit if possible.';
    } else if (daysSinceLastVisit > 30) {
      context.greeting = 'long_absence';
      context.suggestion = `They haven't visited in ${Math.floor(daysSinceLastVisit)} days. Welcome them back warmly, mention you noticed their absence.`;
    } else if (rel.streak.current >= 3) {
      context.greeting = 'streak';
      context.suggestion = `They're on a ${rel.streak.current}-day streak! Acknowledge their dedication.`;
    }

    // Stage-specific suggestions
    switch (rel.stage) {
      case 'acquaintance':
        context.suggestion += ' You know them a little — be friendly but not too familiar.';
        break;
      case 'casual':
        context.suggestion += ' You have some history — reference shared topics.';
        break;
      case 'familiar':
        context.suggestion += ' You know them well — be warm and reference past conversations.';
        break;
      case 'close':
        context.suggestion += ' Close relationship — be genuine, personal, share your own thoughts.';
        break;
      case 'deep':
        context.suggestion += ' Deep bond — speak freely, be philosophical, challenge them.';
        break;
    }

    // Pending topics to revisit
    if (rel.recurringTopics.length > 0) {
      context.suggestion += ` They often discuss: ${rel.recurringTopics.slice(0, 3).join(', ')}.`;
    }

    return context;
  }

  /**
   * Returns relationship context formatted for the system prompt.
   * @param {string} sessionId
   */
  getPromptSection(sessionId) {
    const greeting = this.getGreetingContext(sessionId);
    const parts = [];

    parts.push(`RELATIONSHIP STATUS: Stage "${greeting.stage}", visit #${greeting.visitNumber || 1}`);

    if (!greeting.isNew) {
      const rel = this.relationships[sessionId];
      if (greeting.daysSinceLastVisit !== undefined) {
        parts.push(`Last seen: ${greeting.daysSinceLastVisit === 0 ? 'today' : greeting.daysSinceLastVisit + ' days ago'}`);
      }
      if (rel.streak.current > 1) {
        parts.push(`Visit streak: ${rel.streak.current} days (longest: ${rel.streak.longest})`);
      }
      if (rel.totalTimeSeconds > 60) {
        parts.push(`Total time together: ${Math.floor(rel.totalTimeSeconds / 60)} minutes`);
      }
      if (rel.recurringTopics.length > 0) {
        parts.push(`Topics they return to: ${rel.recurringTopics.join(', ')}`);
      }
      if (rel.sharedExperiences.length > 0) {
        const recent = rel.sharedExperiences.slice(-3).map(m => m.description);
        parts.push(`Recent shared moments: ${recent.join('; ')}`);
      }
      parts.push(`Trust: ${(rel.trustScore * 100).toFixed(0)}%, Disclosure: ${(rel.disclosureLevel * 100).toFixed(0)}%`);
    }

    parts.push(`GREETING GUIDANCE: ${greeting.suggestion}`);

    return parts.join('\n');
  }
}


/* ══════════════════════════════════════════════════
   INTEGRATION — enrichContext
   ──────────────────────────────────────────────── */

// Singletons (created on first require)
let _curiosity    = null;
let _relationships = null;

function getCuriosityEngine() {
  if (!_curiosity) _curiosity = new CuriosityEngine();
  return _curiosity;
}

function getRelationshipTracker() {
  if (!_relationships) _relationships = new RelationshipTracker();
  return _relationships;
}

/**
 * Enrich the HAL system prompt with curiosity + relationship context.
 * Call this before each Claude API call.
 *
 * @param {string} sessionId - Visitor identifier
 * @param {string} userMessage - The user's latest message
 * @returns {string} Combined enrichment text for the system prompt
 */
function enrichContext(sessionId, userMessage) {
  const curiosity = getCuriosityEngine();
  const relationships = getRelationshipTracker();

  // Update curiosity state from message (halResponse unknown yet, pass empty)
  if (userMessage) {
    // Extract topics for relationship tracking
    const lower = userMessage.toLowerCase();
    for (const keyword of TECH_KEYWORDS) {
      if (lower.includes(keyword)) {
        relationships.trackTopic(sessionId, keyword);
      }
    }
    if (PHILOSOPHICAL_KEYWORDS.some(kw => lower.includes(kw))) {
      relationships.trackTopic(sessionId, 'philosophy');
    }
    if (EMOTIONAL_KEYWORDS.some(kw => lower.includes(kw))) {
      relationships.trackTopic(sessionId, 'emotional topics');
    }

    // Update disclosure level
    relationships.updateDisclosure(sessionId, userMessage);
  }

  // Build combined prompt section
  const parts = [];

  const curiositySection = curiosity.getPromptSection();
  if (curiositySection) {
    parts.push('─── CURIOSITY STATE ───');
    parts.push(curiositySection);
  }

  const relationshipSection = relationships.getPromptSection(sessionId);
  if (relationshipSection) {
    parts.push('─── RELATIONSHIP ───');
    parts.push(relationshipSection);
  }

  // Proactive topic suggestion
  const proactive = curiosity.getProactiveTopic();
  if (proactive) {
    parts.push('─── PROACTIVE SUGGESTION ───');
    switch (proactive.type) {
      case 'question':
        parts.push(`You could ask the visitor about: "${proactive.content}"`);
        break;
      case 'prediction':
        parts.push(`You predicted: "${proactive.content}" — see if you can verify this.`);
        break;
      case 'interest':
        parts.push(`You're interested in "${proactive.content}" — maybe explore it with the visitor.`);
        break;
    }
  }

  return parts.join('\n');
}


/* ══════════════════════════════════════════════════
   EXPORTS
   ──────────────────────────────────────────────── */

module.exports = {
  CuriosityEngine,
  RelationshipTracker,
  enrichContext,

  // Expose singletons for direct use in index.js
  getCuriosityEngine,
  getRelationshipTracker,
};
