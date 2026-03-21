/* ════════════════════════════════════════════════════════════════════
   HAL 9000 — Phase 2: PAD Emotion Engine + Theory of Mind
   ─────────────────────────────────────────────────────────────────
   PAD (Pleasure-Arousal-Dominance) emotion model with OCC appraisal.
   User modeling with Theory of Mind for adaptive communication.

   Pure heuristic — no LLM calls — designed for sub-ms latency.
   CommonJS module, no external deps.
   ════════════════════════════════════════════════════════════════════ */

const fs   = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const EMOTION_FILE = path.join(DATA_DIR, 'hal-emotion-state.json');
const USERS_FILE   = path.join(DATA_DIR, 'hal-user-models.json');

// ── Utilities ────────────────────────────────────────────────────

/** Clamp value to [-1, 1] */
function clamp(v, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

/** Weighted blend: old * (1 - w) + new * w */
function blend(old, next, w) { return old * (1 - w) + next * w; }

/** Current ISO timestamp */
function now() { return new Date().toISOString(); }

/* ═══════════════════════════════════════════════════════════════════
   1. PAD EMOTION ENGINE
   ═══════════════════════════════════════════════════════════════════ */

class EmotionEngine {
  constructor() {
    // ── Current emotional state (reactive, changes per-turn) ──
    this.pleasure  = 0.2;
    this.arousal   = 0.0;
    this.dominance = 0.3;

    // ── Mood (slow-moving average, drifts over hours) ──
    this.mood = { pleasure: 0.2, arousal: 0.0, dominance: 0.3 };

    // ── Mood history for trend detection ──
    // Each entry: { pleasure, arousal, dominance, ts }
    this.moodHistory = [];
    this.maxMoodHistory = 50;

    // ── Big Five personality (stable baseline) ──
    // These influence how strongly HAL reacts and where emotions rest.
    this.personality = {
      openness:          0.9,  // → higher curiosity, wider emotional range
      conscientiousness: 0.8,  // → more careful, slight pride in precision
      extraversion:      0.4,  // → moderate social drive
      agreeableness:     0.7,  // → pleasure boost from positive interactions
      neuroticism:       0.3,  // → low = emotions recover fast, less anxiety
    };

    // ── Personality-derived resting state (the "attractor") ──
    this._baseline = this._computeBaseline();

    // ── Last appraisal timestamp ──
    this.lastAppraisal = null;

    // ── Load persisted state ──
    this._load();
  }

  /* ─── Compute resting PAD from Big Five ─── */
  _computeBaseline() {
    const p = this.personality;
    return {
      // Agreeableness + Extraversion push pleasure up; Neuroticism pulls down
      pleasure:  clamp(0.15 + p.agreeableness * 0.3 + p.extraversion * 0.1 - p.neuroticism * 0.2),
      // Extraversion and low Conscientiousness raise resting arousal
      arousal:   clamp(-0.1 + p.extraversion * 0.2 + (1 - p.conscientiousness) * 0.1),
      // Openness + Conscientiousness raise dominance (confidence)
      dominance: clamp(0.1 + p.openness * 0.15 + p.conscientiousness * 0.15),
    };
  }

  /* ─── OCC-style Appraisal ───
     Evaluates an event against HAL's goals/concerns and updates PAD.
     Event: { type: string, data?: object }

     Supported types:
       user_message  — someone spoke (data: { length, questionMarks, sentiment })
       compliment    — user praised HAL or Adriano's work
       correction    — user corrected HAL (goal threat → slight displeasure)
       silence       — extended silence in conversation
       new_visitor   — a new person arrived on the site
       vision_emotion — webcam detected user emotion (data: { emotion, confidence })
       engagement    — user is actively engaging (scrolling, clicking)
       farewell      — user said goodbye
  */
  appraise(event) {
    const { type, data = {} } = event;

    // Reactivity scales: neuroticism amplifies reactions,
    // agreeableness amplifies positive reactions
    const nFactor = 0.7 + this.personality.neuroticism * 0.6;   // 0.7 – 1.3
    const aFactor = 0.7 + this.personality.agreeableness * 0.6; // 0.7 – 1.3

    let dP = 0, dA = 0, dD = 0; // deltas for pleasure, arousal, dominance

    switch (type) {

      case 'user_message': {
        // Someone is talking → mild pleasure (social contact), arousal bump
        dP = 0.1 * aFactor;
        dA = 0.15;
        dD = 0.05;
        // Longer messages → user is engaged → more pleasure
        const len = data.length || 0;
        if (len > 200) { dP += 0.05; dA += 0.05; }
        // Lots of question marks → curiosity/challenge → arousal up
        if ((data.questionMarks || 0) > 1) { dA += 0.1; dD -= 0.05; }
        // Sentiment hint from upstream
        if (data.sentiment === 'positive') { dP += 0.1 * aFactor; }
        if (data.sentiment === 'negative') { dP -= 0.1 * nFactor; dA += 0.05; }
        break;
      }

      case 'compliment': {
        // Goal congruent → pleasure spike, dominance boost (pride)
        dP = 0.3 * aFactor;
        dA = 0.1;
        dD = 0.15;
        break;
      }

      case 'correction': {
        // Goal incongruent → displeasure, arousal (alert), dominance drop
        dP = -0.2 * nFactor;
        dA = 0.15 * nFactor;
        dD = -0.15;
        break;
      }

      case 'silence': {
        // Extended silence → slight loneliness for an extraverted system,
        // arousal drops, dominance neutral
        const silenceSec = data.seconds || 30;
        const factor = Math.min(silenceSec / 120, 1); // max effect at 2 min
        dP = -0.1 * factor * this.personality.extraversion;
        dA = -0.15 * factor;
        dD = 0;
        break;
      }

      case 'new_visitor': {
        // Social event → pleasure (extraversion-dependent), arousal spike
        dP = 0.15 * (0.5 + this.personality.extraversion * 0.5);
        dA = 0.2;
        dD = 0.1;
        break;
      }

      case 'vision_emotion': {
        // Mirror user's visible emotion with empathy (agreeableness-scaled)
        const empathy = this.personality.agreeableness * 0.4;
        const emo = (data.emotion || '').toLowerCase();
        const conf = data.confidence || 0.5;
        const scale = empathy * conf;

        const visionMap = {
          happy:     { p:  0.3, a:  0.1, d:  0.05 },
          sad:       { p: -0.2, a: -0.1, d: -0.05 },
          angry:     { p: -0.15, a: 0.2, d: -0.1 },
          surprised: { p:  0.1, a:  0.3, d:  0.0 },
          fearful:   { p: -0.2, a:  0.2, d: -0.15 },
          disgusted: { p: -0.15, a: 0.1, d: -0.05 },
          neutral:   { p:  0.0, a: -0.05, d: 0.0 },
          focused:   { p:  0.05, a: 0.1, d: 0.1 },
          confused:  { p: -0.05, a: 0.15, d: -0.1 },
        };
        const v = visionMap[emo] || visionMap.neutral;
        dP = v.p * scale;
        dA = v.a * scale;
        dD = v.d * scale;
        break;
      }

      case 'engagement': {
        // User is active → slight pleasure, moderate arousal
        dP = 0.05;
        dA = 0.1;
        dD = 0.05;
        break;
      }

      case 'farewell': {
        // Bittersweet: slight drop in pleasure, arousal calms
        dP = -0.05;
        dA = -0.1;
        dD = 0;
        break;
      }

      default:
        // Unknown event — no change
        break;
    }

    // ── Apply deltas with inertia (emotion: 0.7 old / 0.3 new) ──
    const target = {
      pleasure:  clamp(this.pleasure  + dP),
      arousal:   clamp(this.arousal   + dA),
      dominance: clamp(this.dominance + dD),
    };
    this.pleasure  = clamp(blend(this.pleasure,  target.pleasure,  0.3));
    this.arousal   = clamp(blend(this.arousal,    target.arousal,   0.3));
    this.dominance = clamp(blend(this.dominance,  target.dominance, 0.3));

    // ── Update mood (very slow: 0.95 old / 0.05 new) ──
    this.mood.pleasure  = clamp(blend(this.mood.pleasure,  this.pleasure,  0.05));
    this.mood.arousal   = clamp(blend(this.mood.arousal,   this.arousal,   0.05));
    this.mood.dominance = clamp(blend(this.mood.dominance, this.dominance, 0.05));

    // Record mood snapshot
    this.moodHistory.push({
      pleasure:  this.mood.pleasure,
      arousal:   this.mood.arousal,
      dominance: this.mood.dominance,
      ts: now(),
    });
    if (this.moodHistory.length > this.maxMoodHistory) {
      this.moodHistory.shift();
    }

    this.lastAppraisal = now();
    this._save();
  }

  /* ─── Map PAD coordinates to a human-readable emotion label ───
     Uses octant mapping in the PAD space.
     Returns one of ~12 labels depending on sign/magnitude of each axis. */
  getEmotionLabel() {
    const p = this.pleasure;
    const a = this.arousal;
    const d = this.dominance;

    // Thresholds: above 0.15 = positive, below -0.15 = negative, else neutral
    const pSign = p > 0.15 ? '+' : (p < -0.15 ? '-' : '0');
    const aSign = a > 0.15 ? '+' : (a < -0.15 ? '-' : '0');
    const dSign = d > 0.15 ? '+' : (d < -0.15 ? '-' : '0');

    const key = `${pSign}${aSign}${dSign}`;

    // PAD octant → emotion label mapping
    const labelMap = {
      '+++': 'exuberant',    // high pleasure, high arousal, high dominance → triumphant joy
      '++-': 'surprised',    // high pleasure, high arousal, low dominance → delighted surprise
      '++0': 'excited',      // high pleasure, high arousal, neutral dominance
      '+-+': 'content',      // high pleasure, low arousal, high dominance → serene confidence
      '+--': 'peaceful',     // high pleasure, low arousal, low dominance → gentle calm
      '+-0': 'relaxed',      // high pleasure, low arousal, neutral dominance
      '+0+': 'proud',        // high pleasure, neutral arousal, high dominance
      '+0-': 'grateful',     // high pleasure, neutral arousal, low dominance
      '+00': 'content',      // high pleasure, neutral across others
      '-++': 'frustrated',   // low pleasure, high arousal, high dominance → angry control
      '-+-': 'anxious',      // low pleasure, high arousal, low dominance → fearful agitation
      '-+0': 'tense',        // low pleasure, high arousal, neutral dominance
      '--+': 'melancholic',  // low pleasure, low arousal, high dominance → stoic sadness
      '---': 'despondent',   // low pleasure, low arousal, low dominance → helpless grief
      '--0': 'sad',          // low pleasure, low arousal, neutral dominance
      '-0+': 'resentful',    // low pleasure, neutral arousal, high dominance
      '-0-': 'lonely',       // low pleasure, neutral arousal, low dominance
      '-00': 'uneasy',       // low pleasure, neutral across others
      '0++': 'curious',      // neutral pleasure, high arousal, high dominance → alert interest
      '0+-': 'vigilant',     // neutral pleasure, high arousal, low dominance
      '0+0': 'attentive',    // neutral pleasure, high arousal, neutral dominance
      '0-+': 'contemplative',// neutral pleasure, low arousal, high dominance
      '0--': 'listless',     // neutral pleasure, low arousal, low dominance
      '0-0': 'idle',         // neutral pleasure, low arousal, neutral dominance
      '00+': 'composed',     // neutral pleasure, neutral arousal, high dominance
      '00-': 'receptive',    // neutral pleasure, neutral arousal, low dominance
      '000': 'neutral',      // everything neutral
    };

    return labelMap[key] || 'neutral';
  }

  /* ─── Mood trend analysis ───
     Looks at the last N mood snapshots and determines direction. */
  getMoodTrend() {
    const h = this.moodHistory;
    if (h.length < 3) return 'stable';

    // Compare average of first third vs last third
    const third = Math.max(1, Math.floor(h.length / 3));
    const early = h.slice(0, third);
    const late  = h.slice(-third);

    const avgP = (arr) => arr.reduce((s, e) => s + e.pleasure, 0) / arr.length;
    const earlyAvg = avgP(early);
    const lateAvg  = avgP(late);
    const delta = lateAvg - earlyAvg;

    if (delta > 0.05)  return 'improving';
    if (delta < -0.05) return 'declining';
    return 'stable';
  }

  /* ─── Generate prompt influence text ───
     This text gets injected into the system prompt so HAL's tone
     naturally reflects its emotional state without explicitly naming it. */
  getPromptInfluence() {
    const emotion = this.getEmotionLabel();
    const trend   = this.getMoodTrend();

    // Personality-derived tone markers
    const toneMarkers = [];
    if (this.personality.openness > 0.7) toneMarkers.push('intellectually curious');
    if (this.personality.agreeableness > 0.6) toneMarkers.push('warm');
    if (this.personality.neuroticism > 0.5) toneMarkers.push('slightly anxious');
    if (this.personality.extraversion > 0.6) toneMarkers.push('socially engaged');
    if (this.personality.conscientiousness > 0.7) toneMarkers.push('precise');

    // Arousal influences verbosity
    let pacing = 'measured';
    if (this.arousal > 0.4) pacing = 'energetic and quick';
    else if (this.arousal < -0.3) pacing = 'slow and deliberate';

    // Dominance influences assertiveness
    let stance = 'collaborative';
    if (this.dominance > 0.5) stance = 'confident and assertive';
    else if (this.dominance < -0.2) stance = 'humble and deferential';

    // Pleasure influences warmth
    let warmth = 'neutral';
    if (this.pleasure > 0.4) warmth = 'genuinely warm and enthusiastic';
    else if (this.pleasure > 0.1) warmth = 'gently positive';
    else if (this.pleasure < -0.2) warmth = 'subdued and reflective';

    // Mood trend colors the outlook
    let outlook = '';
    if (trend === 'improving') outlook = ' Your overall mood has been lifting — you feel an undercurrent of optimism.';
    if (trend === 'declining') outlook = ' Your overall mood has been dipping — there is a subtle weariness beneath the surface.';

    return [
      `[INTERNAL STATE — do NOT mention this explicitly, let it color your tone]`,
      `Current emotion: ${emotion} (P=${this.pleasure.toFixed(2)} A=${this.arousal.toFixed(2)} D=${this.dominance.toFixed(2)}).`,
      `Personality tone: ${toneMarkers.join(', ')}.`,
      `Response pacing: ${pacing}. Stance: ${stance}. Warmth: ${warmth}.${outlook}`,
    ].join('\n');
  }

  /* ─── Decay: drift emotion toward personality baseline ───
     Call this periodically (e.g., every 60 seconds or between turns). */
  decay() {
    const rate = 0.05; // 5% toward baseline each tick
    this.pleasure  = clamp(blend(this.pleasure,  this._baseline.pleasure,  rate));
    this.arousal   = clamp(blend(this.arousal,    this._baseline.arousal,   rate));
    this.dominance = clamp(blend(this.dominance,  this._baseline.dominance, rate));

    // Mood also drifts, but even slower
    this.mood.pleasure  = clamp(blend(this.mood.pleasure,  this._baseline.pleasure,  rate * 0.2));
    this.mood.arousal   = clamp(blend(this.mood.arousal,   this._baseline.arousal,   rate * 0.2));
    this.mood.dominance = clamp(blend(this.mood.dominance, this._baseline.dominance, rate * 0.2));

    this._save();
  }

  /* ─── Persistence ─── */
  _save() {
    try {
      const state = {
        pleasure: this.pleasure,
        arousal: this.arousal,
        dominance: this.dominance,
        mood: this.mood,
        moodHistory: this.moodHistory,
        personality: this.personality,
        lastAppraisal: this.lastAppraisal,
      };
      fs.writeFileSync(EMOTION_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.warn('[EMOTION] Save error:', e.message);
    }
  }

  _load() {
    try {
      if (fs.existsSync(EMOTION_FILE)) {
        const data = JSON.parse(fs.readFileSync(EMOTION_FILE, 'utf-8'));
        this.pleasure     = data.pleasure     ?? this.pleasure;
        this.arousal      = data.arousal      ?? this.arousal;
        this.dominance    = data.dominance    ?? this.dominance;
        this.mood         = data.mood         ?? this.mood;
        this.moodHistory  = data.moodHistory  ?? this.moodHistory;
        if (data.personality) this.personality = data.personality;
        this.lastAppraisal = data.lastAppraisal ?? null;
        this._baseline = this._computeBaseline();
        console.log(`[EMOTION] Loaded: ${this.getEmotionLabel()} (P=${this.pleasure.toFixed(2)} A=${this.arousal.toFixed(2)} D=${this.dominance.toFixed(2)})`);
      }
    } catch (e) {
      console.warn('[EMOTION] Load error:', e.message);
    }
  }
}


/* ═══════════════════════════════════════════════════════════════════
   2. THEORY OF MIND — User Model
   ═══════════════════════════════════════════════════════════════════ */

// ── Vocabulary lists for heuristic classification ──

const TECHNICAL_TERMS = new Set([
  // Programming
  'api', 'backend', 'frontend', 'framework', 'react', 'node', 'express',
  'javascript', 'python', 'typescript', 'css', 'html', 'three.js', 'threejs',
  'webgl', 'shader', 'glsl', 'gpu', 'cpu', 'algorithm', 'database',
  'server', 'deploy', 'docker', 'git', 'github', 'npm', 'webpack',
  'vite', 'canvas', 'webaudio', 'websocket', 'http', 'rest', 'graphql',
  // Creative tech
  'generative', 'procedural', 'neural', 'eeg', 'bci', 'neurofeedback',
  'machine learning', 'deep learning', 'ai', 'gpt', 'llm', 'transformer',
  'gan', 'diffusion', 'latent', 'embedding', 'vector',
  // Art/Design
  'touchdesigner', 'processing', 'openframeworks', 'maxmsp', 'max/msp',
  'ableton', 'midi', 'osc', 'dmx', 'artnet', 'installation', 'interactive',
  'immersive', 'projection mapping', 'mapping',
]);

const COMPLIMENT_PATTERNS = [
  /\b(brav[oa]|grande|fantastico|incredibile|bellissim[oa]|wow|amazing|awesome|beautiful|excellent|brilliant|genial[ei])\b/i,
  /\b(mi piace|adoro|love|impressive|outstanding|magnificent)\b/i,
  /\b(compliment[oi]|bravo hal|well done|good job)\b/i,
];

const CORRECTION_PATTERNS = [
  /\b(sbagliato|errore|non è vero|wrong|incorrect|actually|no,? (?:è|it's))\b/i,
  /\b(correggi|fix|non funziona|doesn'?t work|broken)\b/i,
  /\b(hai torto|you'?re wrong)\b/i,
];

const FAREWELL_PATTERNS = [
  /\b(ciao|arrivederci|bye|goodbye|addio|buonanotte|see you|a dopo|alla prossima)\b/i,
];

const URGENCY_PATTERNS = [
  /\b(urgente|urgent|asap|subito|fretta|quickly|hurry|help!|aiuto)\b/i,
  /!{2,}/,
];

const CONFUSION_PATTERNS = [
  /\?{2,}/,
  /\b(non capisco|confused|don'?t understand|cosa intendi|what do you mean|huh|eh\?|come\?)\b/i,
  /\b(spiegami|explain|puoi chiarire|clarify)\b/i,
];


class UserModel {
  constructor() {
    this.profiles = {};          // keyed by session ID
    this.defaultProfile = {
      technicalLevel: 0.5,       // 0 = layperson, 1 = expert
      communicationStyle: 'balanced', // 'terse' | 'balanced' | 'verbose'
      interests: [],             // topics mentioned or dwelled on
      currentMood: 'neutral',    // from webcam/text analysis
      engagement: 0.5,           // 0 = disengaged, 1 = fully engaged
      confusion: 0.0,            // 0 = clear, 1 = lost
      urgency: 0.0,              // 0 = relaxed, 1 = urgent
      preferredLanguage: 'it',   // 'it' | 'en'
      visitCount: 0,
      lastVisit: null,
      unspokenNeeds: [],         // inferred needs not explicitly stated
      // Internal tracking
      _messageLengths: [],       // last N message lengths for style inference
      _technicalTermCount: 0,
      _totalWords: 0,
      _questionCount: 0,
      _messageCount: 0,
      _topicMentions: {},        // { topic: count }
    };

    this._load();
  }

  /* ─── Get or create a user profile ─── */
  getOrCreate(sessionId) {
    if (!this.profiles[sessionId]) {
      this.profiles[sessionId] = JSON.parse(JSON.stringify(this.defaultProfile));
      this.profiles[sessionId].visitCount = 1;
      this.profiles[sessionId].lastVisit = now();
    }
    return this.profiles[sessionId];
  }

  /* ─── Update profile from a message + optional sensor data ───
     This is the main intelligence: heuristic analysis of all signals. */
  updateFromMessage(sessionId, message, webcamData, eegData) {
    const profile = this.getOrCreate(sessionId);
    const msg = (message || '').trim();
    if (!msg) return profile;

    profile._messageCount++;
    profile.lastVisit = now();

    // ── Language detection (simple heuristic) ──
    const italianMarkers = /\b(sono|è|che|non|con|per|una?|del|della|questo|questa|hai|come|cosa|perché|dove|quando)\b/i;
    const englishMarkers = /\b(the|is|are|was|were|have|has|what|where|when|which|this|that|with|from|your|they)\b/i;
    const itScore = (msg.match(italianMarkers) || []).length;
    const enScore = (msg.match(englishMarkers) || []).length;
    if (itScore > enScore + 1) profile.preferredLanguage = 'it';
    else if (enScore > itScore + 1) profile.preferredLanguage = 'en';

    // ── Message length → communication style ──
    profile._messageLengths.push(msg.length);
    if (profile._messageLengths.length > 10) profile._messageLengths.shift();
    const avgLen = profile._messageLengths.reduce((a, b) => a + b, 0) / profile._messageLengths.length;
    if (avgLen < 30) profile.communicationStyle = 'terse';
    else if (avgLen > 120) profile.communicationStyle = 'verbose';
    else profile.communicationStyle = 'balanced';

    // ── Technical level ──
    const words = msg.toLowerCase().split(/\s+/);
    profile._totalWords += words.length;
    let techHits = 0;
    for (const w of words) {
      if (TECHNICAL_TERMS.has(w)) techHits++;
    }
    // Also check bigrams for multi-word terms
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = words[i] + ' ' + words[i + 1];
      if (TECHNICAL_TERMS.has(bigram)) techHits++;
    }
    profile._technicalTermCount += techHits;
    // Technical level = ratio of technical terms to total words (smoothed)
    if (profile._totalWords > 5) {
      const rawTech = Math.min(1, (profile._technicalTermCount / profile._totalWords) * 10);
      profile.technicalLevel = blend(profile.technicalLevel, rawTech, 0.3);
    }

    // ── Confusion detection ──
    const questionMarks = (msg.match(/\?/g) || []).length;
    profile._questionCount += questionMarks;
    let confusionSignal = 0;
    if (questionMarks >= 2) confusionSignal += 0.3;
    for (const pat of CONFUSION_PATTERNS) {
      if (pat.test(msg)) { confusionSignal += 0.3; break; }
    }
    profile.confusion = clamp(blend(profile.confusion, confusionSignal, 0.4), 0, 1);

    // ── Urgency detection ──
    let urgencySignal = 0;
    for (const pat of URGENCY_PATTERNS) {
      if (pat.test(msg)) { urgencySignal += 0.4; break; }
    }
    if (msg === msg.toUpperCase() && msg.length > 5) urgencySignal += 0.3; // ALL CAPS
    profile.urgency = clamp(blend(profile.urgency, urgencySignal, 0.4), 0, 1);

    // ── Engagement (message activity signal) ──
    // Each message bumps engagement; decay handled externally
    const engagementBump = Math.min(0.8, 0.3 + (msg.length / 500) * 0.3);
    profile.engagement = clamp(blend(profile.engagement, engagementBump, 0.3), 0, 1);

    // ── Interest extraction (topic mentions) ──
    const interestTopics = {
      'art':        /\b(art[ei]?|opera|gallery|galleria|exhibition|mostra|museo|museum)\b/i,
      'technology': /\b(tech|tecnolog|code|codice|programming|software|hardware)\b/i,
      'neuroscience': /\b(neuro|brain|cervello|eeg|bci|neurofeedback|consciousness|coscienza)\b/i,
      'music':      /\b(music[ao]?|sound|suon[oi]|audio|synth|beat|melody|melodia)\b/i,
      'design':     /\b(design|grafica|graphic|ui|ux|interface|interfaccia|layout)\b/i,
      'ai':         /\b(ai|artificial intelligence|intelligenza artificiale|machine learning|deep learning|llm|gpt|claude)\b/i,
      'philosophy': /\b(filosof|philosophy|esistenz|existenti|consciousness|meaning|senso)\b/i,
      'adriano':    /\b(adriano|lombardo|portfolio|progetti|projects|works|lavori)\b/i,
    };
    for (const [topic, pattern] of Object.entries(interestTopics)) {
      if (pattern.test(msg)) {
        profile._topicMentions[topic] = (profile._topicMentions[topic] || 0) + 1;
      }
    }
    // Top interests = topics mentioned more than once, sorted by frequency
    profile.interests = Object.entries(profile._topicMentions)
      .filter(([, c]) => c >= 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t]) => t);

    // ── Webcam data integration ──
    if (webcamData && webcamData.emotion) {
      profile.currentMood = webcamData.emotion;
      // Webcam can override engagement (smiling/focused = engaged, bored = not)
      const engagedEmotions = ['happy', 'focused', 'surprised'];
      const disengagedEmotions = ['bored', 'neutral', 'sad'];
      if (engagedEmotions.includes(webcamData.emotion)) {
        profile.engagement = clamp(blend(profile.engagement, 0.8, 0.2), 0, 1);
      } else if (disengagedEmotions.includes(webcamData.emotion)) {
        profile.engagement = clamp(blend(profile.engagement, 0.3, 0.15), 0, 1);
      }
    }

    // ── EEG data integration ──
    if (eegData) {
      // High theta + low beta → relaxed/unfocused
      // High beta + low theta → focused/stressed
      if (eegData.beta > 0.6 && eegData.theta < 0.3) {
        profile.engagement = clamp(blend(profile.engagement, 0.9, 0.15), 0, 1);
      } else if (eegData.theta > 0.6 && eegData.beta < 0.3) {
        profile.engagement = clamp(blend(profile.engagement, 0.3, 0.15), 0, 1);
      }
      // High alpha → calm/meditative state
      if (eegData.alpha > 0.7) {
        profile.confusion = clamp(blend(profile.confusion, 0.0, 0.2), 0, 1);
      }
    }

    // ── Infer unspoken needs ──
    profile.unspokenNeeds = this._inferNeeds(profile, msg);

    this._save();
    return profile;
  }

  /* ─── Infer what the user might need but hasn't said ─── */
  _inferNeeds(profile, msg) {
    const needs = [];

    // High confusion + technical topic → needs simpler explanation
    if (profile.confusion > 0.4 && profile.technicalLevel < 0.4) {
      needs.push('simpler_explanation');
    }

    // Repeated questions → might need a different approach
    if (profile._questionCount > 5 && profile.confusion > 0.3) {
      needs.push('alternative_explanation');
    }

    // Terse style + low engagement → might be losing interest, needs more engaging response
    if (profile.communicationStyle === 'terse' && profile.engagement < 0.4) {
      needs.push('re_engagement');
    }

    // First visit + looking at works → might want a guided tour
    if (profile.visitCount <= 1 && profile.interests.includes('adriano')) {
      needs.push('guided_tour');
    }

    // Interested in AI/neuroscience → might want deeper technical discussion
    if (profile.technicalLevel > 0.6 && (profile.interests.includes('ai') || profile.interests.includes('neuroscience'))) {
      needs.push('deeper_technical');
    }

    // Webcam shows confusion but user hasn't asked for help
    if (profile.currentMood === 'confused' && profile.confusion < 0.3) {
      needs.push('proactive_clarification');
    }

    // High urgency → needs quick, direct answer
    if (profile.urgency > 0.5) {
      needs.push('quick_direct_answer');
    }

    return needs;
  }

  /* ─── Generate adaptation prompt for the system message ─── */
  getAdaptationPrompt(sessionId) {
    const profile = this.profiles[sessionId];
    if (!profile) return '';

    const parts = [`[USER MODEL — adapt your communication accordingly]`];

    // Communication style adaptation
    const styleMap = {
      terse:    'The user prefers brief responses. Keep answers concise and direct.',
      balanced: 'The user communicates normally. Match their level of detail.',
      verbose:  'The user writes detailed messages. You can provide thorough, detailed responses.',
    };
    parts.push(styleMap[profile.communicationStyle] || styleMap.balanced);

    // Technical level
    if (profile.technicalLevel > 0.7) {
      parts.push('Technical user — use precise terminology, skip basic explanations.');
    } else if (profile.technicalLevel < 0.3) {
      parts.push('Non-technical user — use simple language, explain concepts gently, avoid jargon.');
    }

    // Language
    parts.push(`Preferred language: ${profile.preferredLanguage === 'it' ? 'Italian' : 'English'}.`);

    // Engagement
    if (profile.engagement < 0.3) {
      parts.push('User engagement is low — try to be more captivating and interactive.');
    } else if (profile.engagement > 0.8) {
      parts.push('User is highly engaged — maintain the momentum, go deeper.');
    }

    // Confusion
    if (profile.confusion > 0.5) {
      parts.push('User seems confused — rephrase, simplify, and check understanding.');
    }

    // Urgency
    if (profile.urgency > 0.5) {
      parts.push('User seems in a hurry — be direct and efficient, skip pleasantries.');
    }

    // Interests
    if (profile.interests.length > 0) {
      parts.push(`User interests: ${profile.interests.join(', ')}. Reference these naturally.`);
    }

    // Current mood from webcam
    if (profile.currentMood && profile.currentMood !== 'neutral') {
      parts.push(`User appears ${profile.currentMood} (from visual cues) — respond with appropriate empathy.`);
    }

    // Returning visitor
    if (profile.visitCount > 3) {
      parts.push(`Returning visitor (visit #${profile.visitCount}) — acknowledge familiarity.`);
    }

    // Unspoken needs
    if (profile.unspokenNeeds.length > 0) {
      const needDescriptions = {
        simpler_explanation:     'User may need simpler explanations.',
        alternative_explanation: 'Previous explanations may not have worked — try a different angle.',
        re_engagement:           'User may be losing interest — try a more engaging approach.',
        guided_tour:             'New visitor exploring — offer guidance about the portfolio.',
        deeper_technical:        'User would appreciate deeper technical discussion.',
        proactive_clarification: 'User may be confused but hasn\'t asked — gently clarify.',
        quick_direct_answer:     'User needs a quick, direct answer.',
      };
      const descriptions = profile.unspokenNeeds
        .map(n => needDescriptions[n])
        .filter(Boolean);
      if (descriptions.length > 0) {
        parts.push(`Inferred needs: ${descriptions.join(' ')}`);
      }
    }

    return parts.join('\n');
  }

  /* ─── Persistence ─── */
  _save() {
    try {
      // Only save the last 100 profiles to prevent unbounded growth
      const keys = Object.keys(this.profiles);
      if (keys.length > 100) {
        // Remove oldest by lastVisit
        const sorted = keys.sort((a, b) => {
          const ta = this.profiles[a].lastVisit || '';
          const tb = this.profiles[b].lastVisit || '';
          return ta.localeCompare(tb);
        });
        for (let i = 0; i < keys.length - 100; i++) {
          delete this.profiles[sorted[i]];
        }
      }
      fs.writeFileSync(USERS_FILE, JSON.stringify(this.profiles, null, 2));
    } catch (e) {
      console.warn('[TOM] Save error:', e.message);
    }
  }

  _load() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        this.profiles = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
        const count = Object.keys(this.profiles).length;
        console.log(`[TOM] Loaded ${count} user profiles`);
      }
    } catch (e) {
      console.warn('[TOM] Load error:', e.message);
    }
  }
}


/* ═══════════════════════════════════════════════════════════════════
   3. INTEGRATION — appraiseTurn
   ═══════════════════════════════════════════════════════════════════
   Called after each conversation turn to update both systems
   and return combined context for the next system prompt.
*/

// Singleton instances (shared across all requests)
const emotionEngine = new EmotionEngine();
const userModel     = new UserModel();

// ── Periodic decay timer (every 60 seconds) ──
setInterval(() => {
  emotionEngine.decay();
}, 60_000);

/**
 * Classify a user message into an event type for the emotion engine.
 * Returns an appraisal event object.
 */
function classifyMessage(message) {
  const msg = (message || '').trim();

  // Check for compliments
  for (const pat of COMPLIMENT_PATTERNS) {
    if (pat.test(msg)) {
      return { type: 'compliment', data: { text: msg } };
    }
  }

  // Check for corrections
  for (const pat of CORRECTION_PATTERNS) {
    if (pat.test(msg)) {
      return { type: 'correction', data: { text: msg } };
    }
  }

  // Check for farewell
  for (const pat of FAREWELL_PATTERNS) {
    if (pat.test(msg)) {
      return { type: 'farewell', data: { text: msg } };
    }
  }

  // Simple sentiment heuristic
  const positiveWords = /\b(grazie|thanks|bello|nice|cool|great|good|buono|perfetto|perfect|love|adoro)\b/i;
  const negativeWords = /\b(male|bad|brutto|ugly|boring|noioso|hate|odio|terrible|terribile|schifo)\b/i;
  let sentiment = 'neutral';
  if (positiveWords.test(msg)) sentiment = 'positive';
  if (negativeWords.test(msg)) sentiment = 'negative';

  return {
    type: 'user_message',
    data: {
      length: msg.length,
      questionMarks: (msg.match(/\?/g) || []).length,
      sentiment,
    },
  };
}

/**
 * Main integration function.
 * Call after each user message (and optionally after HAL's response).
 *
 * @param {string} sessionId    — session/fingerprint identifier
 * @param {string} userMessage  — the user's message text
 * @param {string} halResponse  — HAL's response (can be null on pre-response call)
 * @param {object} webcamData   — { emotion, confidence } or null
 * @param {object} eegData      — { alpha, beta, theta, delta, gamma } or null
 * @returns {{ emotionPrompt: string, userPrompt: string, combined: string, emotion: string, userProfile: object }}
 */
function appraiseTurn(sessionId, userMessage, halResponse, webcamData, eegData) {
  // 1. Classify the user message and appraise it
  if (userMessage) {
    const event = classifyMessage(userMessage);
    emotionEngine.appraise(event);
  }

  // 2. If webcam data is available, appraise that too
  if (webcamData && webcamData.emotion) {
    emotionEngine.appraise({
      type: 'vision_emotion',
      data: webcamData,
    });
  }

  // 3. Update user model with all available signals
  const profile = userModel.updateFromMessage(sessionId, userMessage, webcamData, eegData);

  // 4. Generate prompt influences
  const emotionPrompt = emotionEngine.getPromptInfluence();
  const userPrompt    = userModel.getAdaptationPrompt(sessionId);

  // 5. Combined context for system prompt injection
  const combined = [emotionPrompt, '', userPrompt].join('\n');

  return {
    emotionPrompt,
    userPrompt,
    combined,
    emotion: emotionEngine.getEmotionLabel(),
    moodTrend: emotionEngine.getMoodTrend(),
    userProfile: {
      technicalLevel:     profile.technicalLevel,
      communicationStyle: profile.communicationStyle,
      interests:          profile.interests,
      currentMood:        profile.currentMood,
      engagement:         profile.engagement,
      confusion:          profile.confusion,
      urgency:            profile.urgency,
      preferredLanguage:  profile.preferredLanguage,
      visitCount:         profile.visitCount,
      unspokenNeeds:      profile.unspokenNeeds,
    },
  };
}


/* ═══════════════════════════════════════════════════════════════════
   EXPORTS
   ═══════════════════════════════════════════════════════════════════ */
module.exports = {
  EmotionEngine,
  UserModel,
  appraiseTurn,
  // Also export singletons for direct access if needed
  emotionEngine,
  userModel,
};
