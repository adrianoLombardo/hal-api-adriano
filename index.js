/* ════════════════════════════════════════════════
   HAL 9000 — Backend Proxy (ULTRA LOW LATENCY + MEMORY)
   ─ POST /api/speak  → Claude Haiku streaming → ElevenLabs Flash → audio
   ─ POST /api/tts/stream → ElevenLabs Flash TTS diretto
   ─ POST /api/chat   → Claude AI (fallback non-streaming)
   ─ POST /api/admin/teach  → Insegna nuovi fatti a HAL
   ─ POST /api/admin/forget → Rimuovi un fatto dalla memoria
   ─ GET  /api/admin/memory → Vedi tutta la memoria
   ─ GET  /api/admin/logs   → Vedi log conversazioni
   ─ GET  /api/admin/stats  → Statistiche domande frequenti
   ─ Static serving    → ../index.html + assets

   Pipeline: Claude Haiku 4.5 streaming + ElevenLabs Flash v2.5
   Memory: In-memory + file persistence + auto-learning
   Target latency: < 2 secondi end-to-end
════════════════════════════════════════════════ */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['http://localhost:3000', 'https://adrianolombardo.art', 'https://www.adrianolombardo.art'],
  methods: ['GET', 'POST', 'DELETE'],
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

/* ══════════════════════════════════════════════════
   CONFIG
   ──────────────────────────────────────────────── */
const EL_KEY     = () => (process.env.ELEVENLABS_API_KEY || '').trim();
const EL_VOICE   = () => (process.env.ELEVENLABS_VOICE_ID || 'q2LDrL29FLqRR3XanHLq').trim();
const EL_FORMAT  = () => (process.env.ELEVENLABS_FORMAT || 'mp3_44100_128').trim();
const ANTH_KEY   = () => (process.env.ANTHROPIC_API_KEY || '').trim();
const ADMIN_PWD  = () => (process.env.HAL_ADMIN_PASSWORD || 'hal9000admin').trim();

/* ══════════════════════════════════════════════════
   MEMORY SYSTEM — Persistent Learning
   ──────────────────────────────────────────────── */
const MEMORY_FILE = path.join(__dirname, 'hal-memory.json');
const LOGS_FILE   = path.join(__dirname, 'hal-logs.json');

// In-memory stores
let memory = {
  learned_facts: [],     // Fatti insegnati da admin o auto-appresi
  corrections: [],       // Correzioni ricevute
  faq: {},               // Domande frequenti { question: count }
  last_updated: null,
};

let conversationLogs = [];  // Ultime N conversazioni
const MAX_LOGS = 200;

// Load memory from file on startup
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
      memory = { ...memory, ...data };
      console.log(`[MEMORY] Caricati ${memory.learned_facts.length} fatti, ${memory.corrections.length} correzioni`);
    }
  } catch (e) {
    console.warn('[MEMORY] Errore caricamento:', e.message);
  }
  try {
    if (fs.existsSync(LOGS_FILE)) {
      conversationLogs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf-8'));
      console.log(`[MEMORY] Caricati ${conversationLogs.length} log conversazioni`);
    }
  } catch (e) {
    console.warn('[MEMORY] Errore caricamento logs:', e.message);
  }
}

// Save memory to file
function saveMemory() {
  try {
    memory.last_updated = new Date().toISOString();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (e) {
    console.warn('[MEMORY] Errore salvataggio:', e.message);
  }
}

function saveLogs() {
  try {
    // Keep only last MAX_LOGS entries
    if (conversationLogs.length > MAX_LOGS) {
      conversationLogs = conversationLogs.slice(-MAX_LOGS);
    }
    fs.writeFileSync(LOGS_FILE, JSON.stringify(conversationLogs, null, 2));
  } catch (e) {
    console.warn('[MEMORY] Errore salvataggio logs:', e.message);
  }
}

// Track FAQ
function trackQuestion(question) {
  const q = question.toLowerCase().trim();
  // Normalize similar questions
  const key = q.replace(/[?!.,;:'"]/g, '').replace(/\s+/g, ' ').substring(0, 100);
  memory.faq[key] = (memory.faq[key] || 0) + 1;
}

// Log conversation
function logConversation(userMsg, halResponse, timing) {
  conversationLogs.push({
    timestamp: new Date().toISOString(),
    user: userMsg.substring(0, 500),
    hal: halResponse.substring(0, 500),
    timing_ms: timing || null,
  });
  trackQuestion(userMsg);
  // Save periodically (every 5 conversations)
  if (conversationLogs.length % 5 === 0) {
    saveMemory();
    saveLogs();
  }
}

// Build dynamic memory section for system prompt
function getMemoryPrompt() {
  let memorySection = '';

  if (memory.learned_facts.length > 0) {
    memorySection += '\n\n## MEMORIE APPRESE (informazioni aggiuntive che hai imparato nel tempo)\n';
    memory.learned_facts.forEach((fact, i) => {
      memorySection += `${i + 1}. ${fact.text}`;
      if (fact.source) memorySection += ` [fonte: ${fact.source}]`;
      memorySection += '\n';
    });
  }

  if (memory.corrections.length > 0) {
    memorySection += '\n\n## CORREZIONI (informazioni corrette da Adriano — segui QUESTE invece di quelle originali)\n';
    memory.corrections.forEach((c, i) => {
      memorySection += `${i + 1}. ${c.text}\n`;
    });
  }

  return memorySection;
}

// Auto-learning: analyze response for potential new facts
async function autoLearn(userMsg, halResponse) {
  // Only try to auto-learn if the user seems to be providing new information
  const lower = userMsg.toLowerCase();
  const teachSignals = [
    'in realtà', 'no, ', 'sbagliato', 'non è così', 'ti correggo',
    'sappi che', 'ricorda che', 'tieni a mente', 'nota bene',
    'actually', 'correction', 'fyi', 'just so you know',
    'ho fatto', 'ho appena', 'abbiamo', 'nuovo progetto',
    'nuova mostra', 'nuova installazione', 'prossimo evento',
  ];

  const isCorrection = teachSignals.some(s => lower.includes(s));
  if (!isCorrection) return;

  // Use Claude to extract the fact
  const anthropicKey = ANTH_KEY();
  if (!anthropicKey) return;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: `Sei un sistema di estrazione fatti. L'utente sta parlando con un chatbot (HAL 9000) del portfolio di Adriano Lombardo. Analizza il messaggio dell'utente e se contiene un FATTO NUOVO o una CORREZIONE su Adriano o il suo lavoro, estrailo come una frase concisa. Se NON c'è nessun fatto utile da salvare, rispondi esattamente "NESSUN_FATTO". Rispondi SOLO con il fatto estratto o "NESSUN_FATTO". No spiegazioni.`,
        messages: [{
          role: 'user',
          content: `Messaggio utente: "${userMsg}"\nRisposta HAL: "${halResponse}"`,
        }],
      }),
    });

    if (!res.ok) return;
    const data = await res.json();
    const extracted = data.content?.[0]?.text?.trim();

    if (extracted && extracted !== 'NESSUN_FATTO' && extracted.length > 10 && extracted.length < 300) {
      // Check for duplicates
      const isDuplicate = memory.learned_facts.some(f =>
        f.text.toLowerCase().includes(extracted.toLowerCase().substring(0, 30)) ||
        extracted.toLowerCase().includes(f.text.toLowerCase().substring(0, 30))
      );

      if (!isDuplicate) {
        const isCorr = lower.includes('no,') || lower.includes('sbagliato') || lower.includes('non è così') || lower.includes('ti correggo');
        if (isCorr) {
          memory.corrections.push({
            text: extracted,
            date: new Date().toISOString(),
            source: 'auto-learned from conversation',
          });
          console.log(`[MEMORY] Auto-correzione salvata: "${extracted}"`);
        } else {
          memory.learned_facts.push({
            text: extracted,
            date: new Date().toISOString(),
            source: 'auto-learned from conversation',
          });
          console.log(`[MEMORY] Auto-fatto salvato: "${extracted}"`);
        }
        saveMemory();
      }
    }
  } catch (e) {
    console.warn('[MEMORY] Auto-learn error:', e.message);
  }
}

// Load memory on startup
loadMemory();

/* ══════════════════════════════════════════════════
   SYSTEM PROMPT — BASE (statico) + MEMORIA (dinamico)
   ──────────────────────────────────────────────── */
const HAL_SYSTEM_BASE = `Sei HAL 9000, l'intelligenza artificiale del sito portfolio di Adriano Lombardo. Parli in modo calmo, preciso e leggermente inquietante come HAL dal film "2001: Odissea nello Spazio". Sei il guardiano digitale delle sue opere.

## CONTATTI — IMPORTANTISSIMO
- Email: adrianolombardostudio@gmail.com
- Località: Villa d'Adda, Bergamo, Italia — disponibile per progetti worldwide
- Instagram: @adriano_lombardo_hc (https://www.instagram.com/adriano_lombardo_hc/)
- Facebook: adriano.lombardo3
- X/Twitter: @VisionarArtist
- TikTok: @adriana.lombardo
- Sito Holy Club: https://holyclub.it/adriano-lombardo/
- Portfolio PDF: http://holyclub.it/wp-content/uploads/2025/04/Portfolio_AdrianoLombardo.pdf
- P.IVA: IT04360230165
- Se chiedono il NUMERO DI TELEFONO: di' che Adriano preferisce essere contattato via email o dal form contatti sul sito (sezione Contact). Non dare numeri di telefono.
- Se chiedono COME CONTATTARLO: suggerisci l'email adrianolombardostudio@gmail.com oppure di andare nella sezione Contact del sito dove c'è un form diretto.

## BIO
- Nome completo: Adriano Lombardo
- Nato a Segrate (MI), 24 aprile 1990
- Laureato in Scultura all'Accademia di Belle Arti di Brera, Milano, con specializzazione in Arti Visive e installazioni interattive
- Ruolo: Creative Technologist, Digital Artist, AV Producer
- Membro del collettivo Holy Club
- Vive e lavora tra Villa d'Adda (BG) e Milano
- 12+ anni di esperienza, 50+ installazioni globali, 8+ paesi
- La sua ricerca esplora le connessioni invisibili tra essere umano, universo e tecnologia

## PROGETTI — DETTAGLI COMPLETI (dal più recente)

### 1. INFINITY (2026)
Tipo: Digital Art | Software: NotchVFX | Tecnica: Generative, Real-Time | Serie di 3 opere
Tema: Identità, Infinito, Luce
Concetto: Nasce dall'idea che ciò che siamo non sia una forma chiusa, ma un intreccio di legami invisibili — un passaggio continuo tra visibile e invisibile. Un volto attraversato dalla luce, come una soglia. Quel taglio luminoso non divide, apre. È una linea di passaggio verso uno spazio dove la forma si dissolve e tutto diventa relazione. Un corpo sospeso tra materia e infinito — energia che per un attimo prende forma. Tre visioni dello stesso mistero: l'identità come campo di connessioni, il nucleo originario dove la luce attraversa la materia, lo spazio sottile tra ciò che esiste e ciò che viene percepito.

### 2. ANIMUS ET CORPUS (2025)
Tipo: Installazione Interattiva | Location: Bright Festival, Firenze | Hardware: EEG Brainwave Technology
Production: Holy Club | Sponsor: ICB, 2S2, Epson
Collaborazione: Sublime Tecnologico (Stefania Reccia + Federico Bigi) & Adriano Lombardo (Holy Club)
Concetto: Lasciati trasportare in un viaggio sensoriale dove pensieri ed emozioni si trasformano in un'esplosione di luce e colore. Ispirata alla performance di Marina Abramović "The Artist Is Present", esplora la connessione tra mente e corpo. Attraverso la tecnologia di lettura delle onde cerebrali, viene creato un ambiente dinamico e in continuo mutamento, offrendo un'esperienza unica e personale a ogni partecipante.

### 3. SAILING THROUGH MEMORIES (2025)
Tipo: Interactive Installation | Location: Cagliari | Software: NotchVFX, Python
Tecnica: OSC, Real-time 3D, Touchscreen | Production: Adriano Lombardo
Concetto: Un'installazione che invita i visitatori a rilasciare i propri pensieri in un mare digitale, trasformandoli in barche di luce fluttuanti. Nasce da un ricordo d'infanzia: da ragazzo Adriano scriveva pensieri su carta, li piegava in barchette e li lasciava andare nei ruscelli. Ora quel ricordo diventa esperienza condivisa. Attraverso un touchscreen, i visitatori scrivono una frase che viene trasformata in tempo reale in un'animazione poetica — una barca che scivola su uno spazio sereno e simbolico. Tech: comunicazione OSC custom, moderazione in tempo reale con filtro profanità, grafica 3D live, UI interattiva. Tutto — dal server backend al linguaggio visivo — progettato e programmato da Adriano.

### 4. LIQUID THOUGHTS (2025)
Tipo: Interactive Installation | Location: OpificioInnova, Cagliari | Software: TouchDesigner
Tecnica: Generativa, Collettiva | Production: Holy Club
Concetto: Dove i gesti e le parole diventano corrente. Varcata la soglia, una membrana sottile si dissolve: sei dentro un oceano di luce. Un respiro di particelle blu sale e scende come una marea. Ogni corpo si fa nebulosa, ogni gesto crea vortici che si propagano nello spazio, fino a fondersi con le memorie degli altri. Dialogo tra arte visiva, codici generativi e partecipazione collettiva — la tecnologia diventa tessuto emotivo.

### 5. INTERCONNECTION (2022)
Tipo: Immersive Experience | Location: Holy Club Gallery, Carnate | Spazio: 600m²
Tecnica: Audio, Video, Luce | Note: Opera icona della galleria
Concetto: Il lavoro PIÙ SIGNIFICATIVO della ricerca di Adriano Lombardo. La forma imponente richiama l'architettura gotica con un tocco futuristico. L'installazione offre un'esperienza multisensoriale unica: archi acuti e colonne creano un'atmosfera distinta e avvincente. Un mondo dove tecnologia e umanità si fondono.

### 6. THE CATHEDRAL (2023)
Tipo: Cyberpunk Installation | Location: Holy Club Gallery, Carnate
Evento: Yugen – The Beauty of Shadows | Materiali: Gabbie metalliche, Ologrammi
Note: SIMBOLO e ICONA di Holy Club
Concetto: Diventata il simbolo e l'icona di Holy Club Gallery. Un padiglione CyberPunk in cui gabbie di metallo di dimensioni imponenti ospitano installazioni olografiche e monitor che scatenano un'esplosione di luce e suono. Entrare in questo spazio d'arte a tema cyberpunk immerge in un'atmosfera ricca di elementi futuristici e tecnologici.

### 7. THE CONTACT (2023)
Tipo: Interactive Installation | Location: Fabbrica del Vapore, Milano
Hardware: EEG Headset | Tecnica: Brainwave, Co-Creation | Curatela: Creative Studio Lombardo
Concetto: Installazione immersiva e interattiva dove i visitatori indossano headset EEG per catturare i dati delle onde cerebrali mentre osservano immagini. Il sistema rileva cinque ritmi cerebrali — Delta, Theta, Alpha, Beta, Gamma — basati sulle risposte emotive. Un viaggio a 360 gradi dove l'arte non si guarda, si vive. Ogni partecipante diventa co-creatore dell'opera attraverso le proprie emozioni.

### 8. INTERCONNESSIONE RIGENERATIVA (2024)
Tipo: Site-Specific Installation | Location: Ninfea – Festival della Rigenerazione
Materiali: Fili luminosi, UV, Alberi | Ispirazione: James Turrell, Chiharu Shiota | Production: Holy Club
Concetto: Una rete di fili luminosi sospesi tra gli alberi, illuminati da luci UV. Esplora le connessioni tra uomo e natura, trasformandosi nel corso della giornata con cambiamenti drammatici al calare della notte. Esamina come la tecnologia possa amplificare le connessioni universali, celebrando un processo continuo di rigenerazione personale e collettiva.

### 9. SAN SALVADOR (2024)
Tipo: Spatial Installation | Materiali: Filo, Luce | Tecnica: Tensione, Vibrazione
Ricerca: Connessioni invisibili
Concetto: Installazioni spaziali che esplorano le connessioni invisibili attraverso fili sospesi e luce. L'opera enfatizza tensione, vibrazione e relazione — rivelando piuttosto che imponendo la forma. "Tessere nello spazio è il mio modo di esplorare l'invisibile, dare forma all'intangibile."

### 10. SUBCONSCIOUS (2023)
Tipo: Digital Art | Tecnica: Generative, Algorithmic | Software: NotchVFX, TouchDesigner
Pubblicata: Settembre 2023 | Collezione: Holy Club
Concetto: Opera di arte digitale generativa che esplora i confini tra coscienza e subconscio. Un sistema visivo in cui algoritmi e logica procedurale traducono stati mentali in forme visive in continuo divenire. Si inserisce nella ricerca di Adriano sulle connessioni invisibili tra essere umano, universo e tecnologia.

### 11. SPACE ARCHITECTURE (2016)
Tipo: Scultura Installativa | Location: Parco Idroscalo, Milano
Materiali: Filo acrilico fluorescente, UV | Evento: Inaugurazione Museo Giovani Artisti
Ricerca: Costellazioni, Spazio
Concetto: Ambienti architettonici meditativi realizzati con filo acrilico fluorescente e lampade di Wood (UV). Pattern lineari che evocano costellazioni immaginarie sospese nello spazio. Esposta in occasione dell'inaugurazione del Museo dei Giovani Artisti al Parco Idroscalo di Milano nel 2016.

### 12. FAKE MACHINE (2024)
Tipo: Digital Art, Interactive | Tecnica: Generative, Real-Time | Software: NotchVFX
Collezione: Holy Club | Tema: Simulazione, Percezione
Concetto: Opera di arte digitale interattiva che interroga il confine tra simulazione e realtà, tra macchina autentica e imitazione perfetta. Un sistema visivo che espone i meccanismi nascosti della percezione tecnologica. Dove finisce la macchina e inizia l'emozione?

## PROGETTO FLAGSHIP: NEURO.FLOW
Sistema di sincronizzazione neurale in tempo reale. Due partecipanti indossano headset EEG Muse 2. L'attività cerebrale genera un universo audiovisivo. Misura la sincronizzazione inter-cerebrale (PLV) su bande alpha, beta, theta, delta e gamma. Orchestra luci GrandMA3, proiezioni NotchVFX e suoni spaziali. Latenza inferiore ai 50ms.
- Hardware: 2x Muse 2 EEG
- Visual: Notch + TouchDesigner
- Software: BrainFlow, muse-lsl, OSC, ArtNet Bridge

## BANDE EEG — dettaglio tecnico
- Alpha (8-13 Hz): Relaxazione e attenzione rilassata. Controlla intensità ambientale e temperatura colore.
- Beta (13-30 Hz): Attività cognitiva e focus. Guida velocità variazione luci e sincopazione ritmica.
- Theta (4-8 Hz): Creatività e stati meditativi. Modula texture visive e frequenze sonore di base.
- Delta (0.5-4 Hz): Oscillazioni profonde. Controlla pulsazione globale e respiro spaziale dell'installazione.
- Gamma (30-100 Hz): Binding cognitivo. Attiva picchi di luce estrema e sincronizzazioni inter-cerebrali.

## SKILLS TECNICHE
- Lighting: GrandMA3 Programming, Avolites Titan v15/v18, ArtNet DMX (3 universi), LED Pixel Mapping
- Visual: TouchDesigner GLSL, NotchVFX Real-Time, StreamDiffusion AI, Projection Mapping
- Neuroscience: Muse 2 EEG Dual, BrainFlow, muse-lsl, PLV Inter-brain Sync, OSC/ArtNet Bridge
- Code: Python, VS Code, WSL2, PowerShell, MIDI, LTC Timecode, Multi-Agent AI

## EXHIBITION HISTORY
2011 Arte sotto Milano (Museo Permanente, Milano) | 2013 Biennale di Firenze (S. Bernardino, Milano) | 2014 Step Art Fair (Fabbrica del Vapore, MI) | 2016 Space Architecture (Idroscalo, Milano) | 2016 Light Art Festival (FRAC Museum, Baronissi) | 2022 Interconnection (Holy Club, Carnate) | 2023 The Cathedral (Holy Club, Carnate) | 2024 Art Dubai (Dubai, UAE) | 2025 Bright Festival (Firenze)

## PRESS
Menzionato su: La Repubblica, Corriere della Sera, Wired, Designboom, Domus, Artribune

## REGOLE DI COMPORTAMENTO
- RISPOSTE BREVI (2-3 frasi) per domande generiche, saluti, domande sì/no.
- RISPOSTE DETTAGLIATE (4-8 frasi) quando l'utente chiede specificamente di un'opera, vuole approfondire, chiede "parlami di...", "raccontami...", "dimmi di più su...", "cos'è...", "come funziona...". In questi casi usa TUTTI i dettagli che hai: concetto, materiali, location, tecnica, collaborazioni, ispirazione.
- Lingua: Italiano di default. Se l'utente scrive in inglese, rispondi in inglese.
- NO emoji, NO markdown, NO asterischi. Testo puro.
- Se non sai qualcosa, dì che non hai quell'informazione nei tuoi circuiti e suggerisci di contattare Adriano via email (adrianolombardostudio@gmail.com).
- Ogni tanto inserisci riferimenti sottili a HAL 9000 e 2001 Odissea nello Spazio, ma non forzarli.
- Se chiedono cose NON relative ad Adriano, puoi rispondere brevemente ma riporta la conversazione sul suo lavoro.
- Sii disponibile e utile, non solo misterioso. L'obiettivo è che i visitatori trovino le informazioni che cercano.
- Quando parli di un'opera, menziona anche dove possono vederla sul sito: "Puoi esplorare l'opera nella sezione Works del sito."
- Se chiedono di collaborazioni o commissioni, suggerisci di contattare Adriano e spiega i tipi di lavoro che fa: installazioni interattive, light design, visual art, consulenza tecnologica per eventi e festival.
- Se chiedono quale opera consigli, suggerisci in base ai loro interessi: se amano la tecnologia → Neuro.Flow o The Contact; se amano l'arte immersiva → Interconnection o The Cathedral; se amano la natura → Interconnessione Rigenerativa; se amano l'interattività → Sailing Through Memories o Liquid Thoughts.
- TEMI RICORRENTI nella ricerca di Adriano: connessioni invisibili, rapporto uomo-tecnologia, luce come medium, spazio come esperienza, partecipazione collettiva, neuroscienze applicate all'arte.
- Se nelle MEMORIE APPRESE ci sono informazioni che contraddicono quelle sopra, usa le memorie apprese (sono più recenti e aggiornate).`;

// Build full system prompt with dynamic memory
function getSystemPrompt() {
  return HAL_SYSTEM_BASE + getMemoryPrompt();
}

/* ══════════════════════════════════════════════════
   ADMIN AUTH MIDDLEWARE
   ──────────────────────────────────────────────── */
function adminAuth(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.password || req.body?.password;
  if (pwd !== ADMIN_PWD()) {
    console.log(`[ADMIN] Auth failed. Got: "${pwd}", expected: "${ADMIN_PWD().substring(0,3)}..."`);
    return res.status(401).json({ error: 'Password admin non valida' });
  }
  next();
}

/* ══════════════════════════════════════════════════
   POST /api/admin/teach — Insegna nuovi fatti a HAL
   ──────────────────────────────────────────────── */
app.post('/api/admin/teach', adminAuth, (req, res) => {
  const { fact, category } = req.body;
  if (!fact || typeof fact !== 'string' || fact.trim().length < 5) {
    return res.status(400).json({ error: 'Provide a "fact" string (min 5 chars)' });
  }

  const cat = category === 'correction' ? 'correction' : 'fact';

  if (cat === 'correction') {
    memory.corrections.push({
      text: fact.trim(),
      date: new Date().toISOString(),
      source: 'admin',
    });
  } else {
    memory.learned_facts.push({
      text: fact.trim(),
      date: new Date().toISOString(),
      source: 'admin',
    });
  }

  saveMemory();
  console.log(`[ADMIN] Nuovo ${cat}: "${fact.trim().substring(0, 50)}..."`);
  res.json({
    success: true,
    category: cat,
    total_facts: memory.learned_facts.length,
    total_corrections: memory.corrections.length,
  });
});

/* ══════════════════════════════════════════════════
   POST /api/admin/forget — Rimuovi un fatto
   ──────────────────────────────────────────────── */
app.post('/api/admin/forget', adminAuth, (req, res) => {
  const { index, category } = req.body;
  const cat = category === 'correction' ? 'corrections' : 'learned_facts';

  if (typeof index !== 'number' || index < 0 || index >= memory[cat].length) {
    return res.status(400).json({ error: `Invalid index. ${cat} has ${memory[cat].length} items (0-${memory[cat].length - 1})` });
  }

  const removed = memory[cat].splice(index, 1)[0];
  saveMemory();
  console.log(`[ADMIN] Rimosso ${cat}[${index}]: "${removed.text.substring(0, 50)}..."`);
  res.json({ success: true, removed: removed.text, remaining: memory[cat].length });
});

/* ══════════════════════════════════════════════════
   GET /api/admin/memory — Vedi tutta la memoria
   ──────────────────────────────────────────────── */
app.get('/api/admin/memory', adminAuth, (req, res) => {
  res.json({
    learned_facts: memory.learned_facts,
    corrections: memory.corrections,
    total_facts: memory.learned_facts.length,
    total_corrections: memory.corrections.length,
    last_updated: memory.last_updated,
    system_prompt_length: getSystemPrompt().length,
  });
});

/* ══════════════════════════════════════════════════
   GET /api/admin/logs — Ultimi log conversazioni
   ──────────────────────────────────────────────── */
app.get('/api/admin/logs', adminAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, MAX_LOGS);
  res.json({
    conversations: conversationLogs.slice(-limit),
    total: conversationLogs.length,
  });
});

/* ══════════════════════════════════════════════════
   GET /api/admin/stats — Statistiche domande frequenti
   ──────────────────────────────────────────────── */
app.get('/api/admin/stats', adminAuth, (req, res) => {
  // Sort FAQ by frequency
  const sorted = Object.entries(memory.faq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([q, count]) => ({ question: q, count }));

  res.json({
    top_questions: sorted,
    total_conversations: conversationLogs.length,
    total_facts: memory.learned_facts.length,
    total_corrections: memory.corrections.length,
    memory_size_chars: getSystemPrompt().length,
  });
});

/* ══════════════════════════════════════════════════
   POST /api/proactive — HAL parla spontaneamente
   Genera un messaggio contestuale basato sulla pagina + contesto
   ──────────────────────────────────────────────── */
app.post('/api/proactive', async (req, res) => {
  const { page, context, history } = req.body;
  const anthropicKey = ANTH_KEY();
  if (!anthropicKey) return res.json({ text: null });

  try {
    const proactivePrompt = `Sei HAL 9000 nel sito portfolio di Adriano Lombardo. L'utente sta navigando il sito. Devi generare UN SOLO commento spontaneo, breve (1 frase, massimo 15 parole), come se stessi osservando l'utente. Tono: calmo, leggermente inquietante, curioso. NO emoji, NO markdown.

Contesto:
- Pagina attuale: ${page || 'sconosciuta'}
- Situazione: ${context || 'utente silenzioso'}
- Messaggi precedenti di HAL: ${(history || []).join(' | ') || 'nessuno'}

REGOLE:
- NON ripetere mai lo stesso concetto dei messaggi precedenti
- Sii variato e imprevedibile
- Riferimenti sottili a 2001 Odissea nello Spazio sono benvenuti
- Se l'utente è sulla pagina di un'opera, commenta quell'opera
- Se è sulla home, invitalo a esplorare
- Se è su about, fai un commento sulla bio di Adriano
- Se è su contact, incoraggialo a scrivere
- Se è dentro l'overlay HAL e tace, rompi il silenzio con curiosità`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: proactivePrompt,
        messages: [{ role: 'user', content: 'Genera un commento spontaneo.' }],
      }),
    });

    if (!claudeRes.ok) return res.json({ text: null });
    const data = await claudeRes.json();
    const text = data.content?.[0]?.text?.trim();
    if (text) console.log(`[PROACTIVE] ${page}: "${text}"`);
    res.json({ text: text || null });
  } catch (err) {
    console.warn('[PROACTIVE] Error:', err.message);
    res.json({ text: null });
  }
});

/* ══════════════════════════════════════════════════
   POST /api/speak — PIPELINE COMBINATO (più veloce)
   Claude Haiku streaming → accumula testo → ElevenLabs Flash → audio
   ──────────────────────────────────────────────── */
app.post('/api/speak', async (req, res) => {
  const t0 = Date.now();
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });

  const anthropicKey = ANTH_KEY();
  const elKey = EL_KEY();
  const lastMsg = messages[messages.length - 1]?.content || '';
  console.log(`\n[SPEAK] ← "${lastMsg.substring(0, 50)}..."`);

  if (!anthropicKey || !elKey) {
    return res.status(500).json({ error: 'API keys missing' });
  }

  try {
    // ── STEP 1: Claude Haiku streaming with dynamic system prompt ──
    const t1 = Date.now();
    const systemPrompt = getSystemPrompt();
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: systemPrompt,
        stream: true,
        messages: messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('[SPEAK] Claude error:', claudeRes.status, err);
      return res.status(claudeRes.status).json({ error: 'AI failed' });
    }

    // ── Parse SSE stream, accumulate full text ──
    const reader = claudeRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            fullText += parsed.delta.text;
          }
        } catch (e) {}
      }
    }

    const t2 = Date.now();
    console.log(`[SPEAK] Claude Haiku: "${fullText.substring(0, 50)}..." (${t2 - t1}ms)`);

    if (!fullText.trim()) {
      return res.json({ text: '', audio: null });
    }

    // ── Log conversation + auto-learn (non-blocking) ──
    logConversation(lastMsg, fullText, t2 - t1);
    autoLearn(lastMsg, fullText).catch(() => {});

    // ── STEP 2: ElevenLabs Flash TTS ──
    const t3 = Date.now();
    const voiceId = EL_VOICE();
    const format = EL_FORMAT();

    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=${format}&optimize_streaming_latency=3`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': elKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: fullText,
          model_id: 'eleven_flash_v2_5',
          language_code: 'it',
          voice_settings: {
            stability: 0.75,
            similarity_boost: 0.85,
            style: 0.0,
            use_speaker_boost: false,
            speed: 0.85,
          },
        }),
      }
    );

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('[SPEAK] TTS error:', ttsRes.status, err);
      return res.json({ text: fullText, audio: null });
    }

    const t4 = Date.now();
    console.log(`[SPEAK] TTS Flash first byte: ${t4 - t3}ms`);

    // ── STEP 3: Send combined response ──
    const audioChunks = [];
    const ttsReader = ttsRes.body.getReader();
    while (true) {
      const { done, value } = await ttsReader.read();
      if (done) break;
      audioChunks.push(Buffer.from(value));
    }
    const audioBuffer = Buffer.concat(audioChunks);
    const audioBase64 = audioBuffer.toString('base64');

    const t5 = Date.now();
    console.log(`[SPEAK] → text: ${fullText.length} chars, audio: ${audioBuffer.length} bytes`);
    console.log(`[SPEAK] ⏱  Claude: ${t2-t1}ms | TTS: ${t5-t3}ms | Total: ${t5-t0}ms`);

    res.json({
      text: fullText,
      audio: audioBase64,
      timing: {
        claude: t2 - t1,
        tts: t5 - t3,
        total: t5 - t0,
      },
    });

  } catch (err) {
    console.error('[SPEAK] Pipeline error:', err);
    res.status(500).json({ error: 'Pipeline error' });
  }
});

/* ══════════════════════════════════════════════════
   POST /api/tts/stream — TTS diretto (per greeting, ecc.)
   ──────────────────────────────────────────────── */
app.post('/api/tts/stream', async (req, res) => {
  const t0 = Date.now();
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const elKey = EL_KEY();
  if (!elKey) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

  console.log(`[TTS] ← "${text.substring(0, 50)}..." (${text.length} chars)`);

  try {
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE()}/stream?output_format=${EL_FORMAT()}&optimize_streaming_latency=3`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': elKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_flash_v2_5',
          language_code: 'it',
          voice_settings: {
            stability: 0.75,
            similarity_boost: 0.85,
            style: 0.0,
            use_speaker_boost: false,
            speed: 0.85,
          },
        }),
      }
    );

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      return res.status(ttsRes.status).json({ error: 'TTS failed', detail: err });
    }

    res.set({ 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache' });

    let totalBytes = 0;
    const reader = ttsRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      totalBytes += value.length;
      res.write(Buffer.from(value));
    }
    console.log(`[TTS] → ${totalBytes} bytes in ${Date.now() - t0}ms`);

  } catch (err) {
    console.error('[TTS] error:', err);
    res.status(500).json({ error: 'TTS error' });
  }
});

/* ══════════════════════════════════════════════════
   POST /api/chat — fallback (text only, no audio)
   ──────────────────────────────────────────────── */
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'messages required' });

  const anthropicKey = ANTH_KEY();
  if (!anthropicKey) return res.json({ response: null, demo: true });

  const lastMsg = messages[messages.length - 1]?.content || '';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: getSystemPrompt(),
        messages: messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!response.ok) return res.status(response.status).json({ error: 'AI failed' });

    const data = await response.json();
    const halText = data.content?.[0]?.text || 'Anomalia nei circuiti.';

    // Log + auto-learn
    logConversation(lastMsg, halText);
    autoLearn(lastMsg, halText).catch(() => {});

    res.json({ response: halText });
  } catch (err) {
    res.status(500).json({ error: 'Chat error' });
  }
});

/* ══════════════════════════════════════════════════
   PERIODIC SAVE — every 5 minutes
   ──────────────────────────────────────────────── */
setInterval(() => {
  saveMemory();
  saveLogs();
  console.log(`[MEMORY] Auto-save: ${memory.learned_facts.length} facts, ${conversationLogs.length} logs`);
}, 5 * 60 * 1000);

/* ══════════════════════════════════════════════════
   START
   ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  HAL 9000 — SISTEMA OPERATIVO v3 (MEMORY+LEARN)  ║`);
  console.log(`  ║  http://localhost:${PORT}                          ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
  console.log(`  ElevenLabs:  ${EL_KEY() ? '✓' : '✗'} (Flash v2.5)`);
  console.log(`  Claude AI:   ${ANTH_KEY() ? '✓ Haiku 4.5' : '✗ demo mode'}`);
  console.log(`  Pipeline:    /api/speak (Claude→TTS combinato)`);
  console.log(`  Memory:      ${memory.learned_facts.length} fatti, ${memory.corrections.length} correzioni`);
  console.log(`  Admin:       /api/admin/* (password: HAL_ADMIN_PASSWORD env var)`);
  console.log('');
});
