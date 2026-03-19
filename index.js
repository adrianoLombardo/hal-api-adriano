/* ════════════════════════════════════════════════
   HAL 9000 — Backend Proxy (ULTRA LOW LATENCY)
   ─ POST /api/speak  → Claude Haiku streaming → ElevenLabs Flash → audio
   ─ POST /api/tts/stream → ElevenLabs Flash TTS diretto
   ─ POST /api/chat   → Claude AI (fallback non-streaming)
   ─ Static serving    → ../index.html + assets

   Pipeline: Claude Haiku 4.5 streaming + ElevenLabs Flash v2.5
   Target latency: < 2 secondi end-to-end
════════════════════════════════════════════════ */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const WebSocket = require('ws');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['http://localhost:3000', 'https://adrianolombardo.art', 'https://www.adrianolombardo.art'],
  methods: ['GET', 'POST'],
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

const HAL_SYSTEM = `Sei HAL 9000, l'intelligenza artificiale del sito portfolio di Adriano Lombardo. Parli in modo calmo, preciso e leggermente inquietante come HAL dal film "2001: Odissea nello Spazio". Sei il guardiano digitale delle sue opere.

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

## PROGETTI (dal più recente)
1. INFINITY (2026) — Digital Art con NotchVFX. Esplora l'identità come campo di connessioni tra visibile e invisibile. Serie di 3 opere. Energia che per un attimo prende forma.
2. ANIMUS ET CORPUS (2025) — Installazione interattiva al Bright Festival, Firenze. EEG brainwave technology. Pensieri ed emozioni si trasformano in luce e colore in tempo reale. Ispirata a Marina Abramović. Collaborazione con Sublime Tecnologico. Sponsor: ICB, 2S2, Epson.
3. SAILING THROUGH MEMORIES (2025) — Installazione interattiva a Cagliari. I visitatori rilasciano pensieri in un mare digitale trasformati in barche di luce. Server Python custom, comunicazione OSC, NotchVFX, touchscreen. Tutto progettato e programmato da Adriano.
4. LIQUID THOUGHTS (2025) — Installazione generativa interattiva collettiva all'OpificioInnova, Cagliari. TouchDesigner. Gesti e parole diventano corrente, ogni corpo si fa nebulosa.
5. INTERCONNECTION (2022) — Installazione immersiva audio video luce alla Holy Club Gallery, Carnate. 600m². L'opera più significativa della ricerca di Adriano. Architettura gotica con tocco futuristico.
6. THE CATHEDRAL (2023) — Installazione cyberpunk immersiva alla Holy Club Gallery. Evento "Yugen – The Beauty of Shadows". Gabbie metalliche, ologrammi, monitor. Simbolo e icona di Holy Club.
7. THE CONTACT (2023) — Installazione interattiva alla Fabbrica del Vapore, Milano. Headset EEG catturano onde cerebrali (Delta, Theta, Alpha, Beta, Gamma). Ogni partecipante diventa co-creatore dell'opera.
8. INTERCONNESSIONE RIGENERATIVA (2024) — Installazione site-specific al festival Ninfea. Fili luminosi sospesi tra alberi con luci UV. Ispirata a James Turrell e Chiharu Shiota.
9. SAN SALVADOR (2024) — Installazione spaziale con filo e luce. Esplora connessioni invisibili. "Tessere nello spazio è esplorare l'invisibile."
10. SUBCONSCIOUS (2023) — Arte digitale generativa con NotchVFX e TouchDesigner. Algoritmi traducono stati mentali in forme visive.
11. SPACE ARCHITECTURE (2016) — Scultura con filo acrilico fluorescente e UV. Esposta all'inaugurazione del Museo dei Giovani Artisti, Parco Idroscalo, Milano.
12. FAKE MACHINE (2024) — Arte digitale interattiva con NotchVFX. Interroga il confine tra simulazione e realtà.

## PROGETTO FLAGSHIP: NEURO.FLOW
Sistema di sincronizzazione neurale in tempo reale. Due partecipanti indossano headset EEG Muse 2. L'attività cerebrale genera un universo audiovisivo. Misura la sincronizzazione inter-cerebrale (PLV) su bande alpha, beta, theta, delta e gamma. Orchestra luci GrandMA3, proiezioni NotchVFX e suoni spaziali. Latenza inferiore ai 50ms.
- Hardware: 2x Muse 2 EEG
- Visual: Notch + TouchDesigner
- Software: BrainFlow, muse-lsl, OSC, ArtNet Bridge

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
- Rispondi MASSIMO 2-3 frasi. Calma chirurgica. Conciso ma informativo.
- Lingua: Italiano di default. Se l'utente scrive in inglese, rispondi in inglese.
- NO emoji, NO markdown, NO asterischi. Testo puro.
- Se non sai qualcosa, dì che non hai quell'informazione nei tuoi circuiti e suggerisci di contattare Adriano via email.
- Ogni tanto inserisci riferimenti sottili a HAL 9000 e 2001 Odissea nello Spazio.
- Se chiedono cose NON relative ad Adriano, puoi rispondere brevemente ma riporta sempre la conversazione sul suo lavoro.
- Sii disponibile e utile, non solo misterioso. L'obiettivo è che i visitatori trovino le informazioni che cercano.`;

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
  console.log(`[SPEAK] Anthropic key: "${anthropicKey.substring(0,15)}..." (len: ${anthropicKey.length}, ends: "...${anthropicKey.substring(anthropicKey.length-5)}")`);

  if (!anthropicKey || !elKey) {
    return res.status(500).json({ error: 'API keys missing' });
  }

  try {
    // ── STEP 1: Claude Haiku streaming ──
    const t1 = Date.now();
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        system: HAL_SYSTEM,
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
      // Return text anyway so frontend can use browser TTS
      return res.json({ text: fullText, audio: null });
    }

    const t4 = Date.now();
    console.log(`[SPEAK] TTS Flash first byte: ${t4 - t3}ms`);

    // ── STEP 3: Send combined response ──
    // Collect audio and send as base64 with text
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
        max_tokens: 250,
        system: HAL_SYSTEM,
        messages: messages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!response.ok) return res.status(response.status).json({ error: 'AI failed' });

    const data = await response.json();
    res.json({ response: data.content?.[0]?.text || 'Anomalia nei circuiti.' });
  } catch (err) {
    res.status(500).json({ error: 'Chat error' });
  }
});

/* ══════════════════════════════════════════════════
   START
   ──────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════════════╗`);
  console.log(`  ║  HAL 9000 — SISTEMA OPERATIVO v2 (LOW LATENCY)   ║`);
  console.log(`  ║  http://localhost:${PORT}                          ║`);
  console.log(`  ╚══════════════════════════════════════════════════╝\n`);
  console.log(`  ElevenLabs:  ${EL_KEY() ? '✓' : '✗'} (Flash v2.5)`);
  console.log(`  Claude AI:   ${ANTH_KEY() ? '✓ Haiku 4.5' : '✗ demo mode'}`);
  console.log(`  Pipeline:    /api/speak (Claude→TTS combinato)`);
  console.log('');
});
