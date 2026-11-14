import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  Type,
} from '@google/genai';
import type {
  FunctionDeclaration,
  LiveServerMessage,
} from '@google/genai';
import {
  buildSalesforceCasePayload,
  buildZendeskTicketPayload,
  computeTicketPriority,
  generateExternalTicketId,
} from './src/lib/triage.ts';
import {
  buildLanguageTransitionMessage,
  detectLanguageSwitchIntent,
  detectMidStreamLanguageSwitch,
  detectScriptLanguageHint,
  mergeTranscriptChunk,
  normalizeLanguageName,
  resolveConversationLanguage,
  upsertLanguageTag,
} from './src/lib/language.ts';
import {
  encodePcm16ToWav,
  isLiveApiQuotaOrUnavailableError,
  UtteranceVadAccumulator,
} from './src/lib/voiceBridge.ts';
import {
  DEFAULT_TRIAGE_RULES,
  INITIAL_CONNECTORS,
  INITIAL_TICKETS,
} from './src/lib/seedData.ts';
import type {
  CrmConnectorConfig,
  CrmPlatform,
  CrmTicket,
  NluAnalysis,
  TriageRule,
  VoicePersona,
} from './src/types/support.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

function getGeminiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Add it in Settings > Secrets to enable Gemini Voice & NLU.'
    );
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      ...(apiVersion ? { apiVersion } : {}),
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// In-memory store initialized from deterministic seed state
const crmState: {
  tickets: CrmTicket[];
  rules: TriageRule[];
  connectors: CrmConnectorConfig[];
  sequence: number;
} = {
  tickets: INITIAL_TICKETS.map((t) => ({ ...t, tags: [...t.tags] })),
  rules: DEFAULT_TRIAGE_RULES.map((r) => ({ ...r, intents: [...r.intents], autoTags: [...r.autoTags] })),
  connectors: INITIAL_CONNECTORS.map((c) => ({ ...c })),
  sequence: 15,
};

const nluResponseSchema = {
  type: Type.OBJECT,
  properties: {
    reply: {
      type: Type.STRING,
      description:
        'Concise, empathetic, low-latency customer support response (2-3 sentences max) directly addressing the caller issue and next step.',
    },
    intent: {
      type: Type.STRING,
      description:
        'Normalized snake_case intent such as outage_escalation, billing_dispute, sso_configuration, account_renewal, refund_request, or general_inquiry.',
    },
    confidence: {
      type: Type.NUMBER,
      description: 'Confidence score between 0.0 and 1.0.',
    },
    sentiment: {
      type: Type.STRING,
      description: 'One of: Positive, Neutral, Mixed, Negative.',
    },
    sentimentScore: {
      type: Type.NUMBER,
      description: 'Continuous valence score from -1.0 (very negative) to 1.0 (very positive).',
    },
    emotion: {
      type: Type.STRING,
      description: 'Primary detected emotion such as Urgent, Frustrated, Calm, Relieved, Satisfied.',
    },
    urgencySignals: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Short phrases indicating urgency, SLA breach, outage, or cancellation threat.',
    },
    entities: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          type: { type: Type.STRING },
          value: { type: Type.STRING },
        },
      },
      description: 'Key entities extracted such as Region, Invoice, ErrorCode, Seats, Provider.',
    },
    subject: {
      type: Type.STRING,
      description: 'Short 6-10 word CRM ticket subject line.',
    },
    summary: {
      type: Type.STRING,
      description: '1-2 sentence objective CRM summary for the support engineer.',
    },
    detectedLanguage: {
      type: Type.STRING,
      description:
        'Detected language of the latest caller utterance, e.g. English, Hindi, Hinglish, Spanish, French, Marathi.',
    },
    requestedLanguage: {
      type: Type.STRING,
      description:
        'If the caller explicitly asked to switch/speak in a specific language (e.g. English, Hindi, Spanish), return that canonical language name; otherwise empty string "".',
    },
    switchPending: {
      type: Type.BOOLEAN,
      description:
        'True if the caller asked to talk in another/different language without naming which language yet; otherwise false.',
    },
    activeLanguage: {
      type: Type.STRING,
      description: 'The single language in which the reply is written.',
    },
  },
  required: [
    'reply',
    'intent',
    'confidence',
    'sentiment',
    'sentimentScore',
    'emotion',
    'urgencySignals',
    'entities',
    'subject',
    'summary',
    'detectedLanguage',
    'requestedLanguage',
    'switchPending',
    'activeLanguage',
  ],
};

async function runLowLatencyNluTurn(params: {
  utterance: string;
  customerName: string;
  company: string;
  slaTier: 'Enterprise' | 'Growth' | 'Standard';
  history: Array<{ speaker: string; text: string }>;
  lockedLanguage?: string | null;
  switchPending?: boolean;
}) {
  const ai = getGeminiClient();
  const startedAt = performance.now();

  const normalizedLocked = normalizeLanguageName(params.lockedLanguage);
  const preSwitch = detectLanguageSwitchIntent(params.utterance, {
    switchPending: params.switchPending,
  });
  const scriptHint = detectScriptLanguageHint(params.utterance);

  let languageDirective = '';
  if (preSwitch.requestedLanguage) {
    languageDirective = `CRITICAL LANGUAGE SWITCH DIRECTIVE: The caller explicitly asked to switch to ${preSwitch.requestedLanguage}. Book this session to ${preSwitch.requestedLanguage}, briefly confirm the switch in ${preSwitch.requestedLanguage}, and write your ENTIRE "reply" exclusively in ${preSwitch.requestedLanguage}.`;
  } else if (preSwitch.switchPending) {
    const askIn = normalizedLocked || scriptHint || 'Hindi';
    languageDirective = `CRITICAL LANGUAGE SWITCH PROMPT: The caller wants to switch to another language but has not named which one yet. Reply concisely in ${askIn} asking which language they prefer to continue in.`;
  } else if (normalizedLocked) {
    languageDirective = `CRITICAL TOPIC CONTINUITY LOCK: The booked active language for this topic is ${normalizedLocked}. You MUST write your ENTIRE "reply" strictly in ${normalizedLocked} to continue the topic consistently. Do NOT revert to or repeat English, even if the caller mixes in English technical words (API, 502, CRM, SLA, invoice). Only switch if the caller explicitly requests a different language.`;
  } else {
    languageDirective = `CRITICAL INITIAL LANGUAGE LOCK: Match the caller's language (${scriptHint ? `detected script: ${scriptHint}` : 'detect from utterance'}), lock onto that single language, and write your ENTIRE "reply" strictly in that same language. Never default back to English when the caller uses another language.`;
  }

  const historyBlock = params.history
    .slice(-6)
    .map((h) => `${h.speaker === 'caller' ? 'Caller' : 'Agent'}: ${h.text}`)
    .join('\n');

  const prompt = `Customer Profile: ${params.customerName} (${params.company}, SLA Tier: ${params.slaTier})
Current Booked Language: ${normalizedLocked || 'Auto (not yet locked)'}
Switch Pending Confirmation: ${params.switchPending ? 'Yes' : 'No'}
${languageDirective}

Recent Transcript:
${historyBlock || '(Start of call)'}

Latest Caller Utterance:
"${params.utterance}"

Analyze intent, sentiment (-1.0 to 1.0), emotion, urgency signals, entities, and language state, and craft a crisp, helpful spoken-style support response strictly obeying the language directive.`;

  const nluSystemInstruction =
    'You are Meridian Voice AI, a helpful, low-latency multilingual voice and customer support assistant. Answer ANY question, greeting, general query, or support issue the user brings up naturally in 1-3 clear spoken sentences (using general_inquiry for everyday/casual questions). Stay strictly in the caller’s locked conversation language across the entire topic—never revert to or repeat English unless the caller speaks English or explicitly asks to switch to English—and extract accurate NLU & sentiment JSON.';

  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        abortSignal: AbortSignal.timeout(8000),
        systemInstruction: nluSystemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        responseMimeType: 'application/json',
        responseSchema: nluResponseSchema,
      },
    });
  } catch (primaryErr: unknown) {
    const errText = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    if (/API_KEY_INVALID|PERMISSION_DENIED/i.test(errText)) {
      throw primaryErr;
    }
    console.warn('[NLU] gemini-4-hydrogen slow/unavailable, falling back to gemini-3.1-flash-lite:', errText);
    response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: prompt,
      config: {
        abortSignal: AbortSignal.timeout(10000),
        systemInstruction: nluSystemInstruction,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json',
        responseSchema: nluResponseSchema,
      },
    });
  }

  const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
  const raw = (response.text ?? '{}').trim();
  const parsed = JSON.parse(raw) as {
    reply: string;
    intent: string;
    confidence: number;
    sentiment: 'Positive' | 'Neutral' | 'Mixed' | 'Negative';
    sentimentScore: number;
    emotion: string;
    urgencySignals: string[];
    entities: Array<{ type: string; value: string }>;
    subject: string;
    summary: string;
    detectedLanguage?: string;
    requestedLanguage?: string;
    switchPending?: boolean;
    activeLanguage?: string;
  };

  const languageResolution = resolveConversationLanguage({
    currentLockedLanguage: normalizedLocked,
    detectedInputLanguage: parsed.detectedLanguage || scriptHint || parsed.activeLanguage,
    explicitRequestedLanguage: preSwitch.requestedLanguage || parsed.requestedLanguage,
    switchPending: preSwitch.switchPending || Boolean(parsed.switchPending),
  });

  const validSentiment = ['Positive', 'Neutral', 'Mixed', 'Negative'].includes(parsed.sentiment)
    ? parsed.sentiment
    : 'Neutral';

  const nlu: NluAnalysis = {
    intent: parsed.intent || 'general_inquiry',
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence ?? 0.88))),
    sentiment: validSentiment,
    sentimentScore: Math.min(1, Math.max(-1, Number(parsed.sentimentScore ?? 0))),
    emotion: parsed.emotion || 'Calm',
    urgencySignals: Array.isArray(parsed.urgencySignals) ? parsed.urgencySignals : [],
    entities: Array.isArray(parsed.entities) ? parsed.entities : [],
    summary: parsed.summary || params.utterance.slice(0, 140),
    language: languageResolution.activeLanguage,
  };

  return {
    reply: parsed.reply,
    subject: parsed.subject || 'Support Voice Escalation',
    nlu,
    latencyMs,
    activeLanguage: languageResolution.activeLanguage,
    languageSwitched: languageResolution.switched,
    switchPending: languageResolution.switchPending,
  };
}

async function transcribeBridgeWav(wavBuffer: Buffer): Promise<string> {
  const ai = getGeminiClient();
  const audioPart = {
    inlineData: {
      mimeType: 'audio/wav',
      data: wavBuffer.toString('base64'),
    },
  };
  const instruction =
    'Transcribe the exact spoken words in their original script and language. Return ONLY the spoken words with no commentary or quotes. If there is only silence or background noise, return an empty string.';

  try {
    const res = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: { parts: [audioPart, { text: instruction }] },
    });
    return (res.text ?? '').trim();
  } catch (err) {
    console.warn(
      '[VoiceBridge] gemini-3.5-transcribe failed, falling back to gemini-3.1-flash-lite:',
      err instanceof Error ? err.message : err
    );
    try {
      const fallback = await ai.models.generateContent({
        model: 'gemini-3.1-flash-lite',
        contents: { parts: [audioPart, { text: instruction }] },
        config: { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } },
      });
      return (fallback.text ?? '').trim();
    } catch {
      const fallback2 = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts: [audioPart, { text: instruction }] },
        config: { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } },
      });
      return (fallback2.text ?? '').trim();
    }
  }
}

function stripWavHeaderIfPresent(buf: Buffer): Buffer {
  if (
    buf.length > 44 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  ) {
    const dataOffset = buf.indexOf('data', 12);
    if (dataOffset >= 12 && dataOffset + 8 <= buf.length) {
      return buf.subarray(dataOffset + 8);
    }
    return buf.subarray(44);
  }
  return buf;
}

async function synthesizeBridgeTtsChunks(
  text: string,
  voiceName: VoicePersona,
  onChunk: (pcm24kBase64: string) => void
): Promise<{ ok: boolean; error?: string; wavBase64?: string }> {
  const cleanText = text.trim();
  if (!cleanText) return { ok: false, error: 'Empty text' };
  const ai = getGeminiClient('v1beta');
  const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'] as const;
  let lastError = '';

  for (const model of ttsModels) {
    // 1. Try streaming raw PCM chunks first for lowest latency
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents: [
          {
            role: 'user',
            parts: [{ text: cleanText }],
          },
        ],
        config: {
          abortSignal: AbortSignal.timeout(10000),
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      let emitted = 0;
      for await (const chunk of stream) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          const data = part.inlineData?.data;
          if (data) {
            const rawBuf = Buffer.from(data, 'base64');
            const pcmBuf = emitted === 0 ? stripWavHeaderIfPresent(rawBuf) : rawBuf;
            if (pcmBuf.length >= 2) {
              onChunk(pcmBuf.toString('base64'));
              emitted += 1;
            }
          }
        }
      }
      if (emitted > 0) return { ok: true };
    } catch (streamErr) {
      lastError = streamErr instanceof Error ? streamErr.message : String(streamErr);
      console.warn(`[VoiceBridge] ${model} stream failed:`, lastError);
    }

    // 2. Fallback to unary generateContent (returns WAV)
    try {
      const unary = await ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [{ text: cleanText }],
          },
        ],
        config: {
          abortSignal: AbortSignal.timeout(10000),
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const parts = unary.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const data = part.inlineData?.data;
        if (data) {
          const buf = Buffer.from(data, 'base64');
          const pcm = stripWavHeaderIfPresent(buf);
          if (pcm.length >= 2) {
            onChunk(pcm.toString('base64'));
          }
          const isWav =
            buf.length > 44 &&
            buf.toString('ascii', 0, 4) === 'RIFF' &&
            buf.toString('ascii', 8, 12) === 'WAVE';
          return {
            ok: true,
            ...(isWav ? { wavBase64: data } : {}),
          };
        }
      }
    } catch (unaryErr) {
      lastError = unaryErr instanceof Error ? unaryErr.message : String(unaryErr);
      console.warn(`[VoiceBridge] ${model} unary failed:`, lastError);
    }
  }

  return { ok: false, error: lastError || 'No audio returned from TTS model' };
}

function upsertCrmTicketFromAnalysis(input: {
  activeTicketId?: string;
  platform: CrmPlatform;
  customerName: string;
  company: string;
  customerEmail: string;
  slaTier: 'Enterprise' | 'Growth' | 'Standard';
  subject: string;
  nlu: NluAnalysis;
  latencyMs: number;
  activeLanguage?: string | null;
  existingTicket?: CrmTicket | null;
  rulesOverride?: TriageRule[] | null;
}) {
  const activeRules =
    Array.isArray(input.rulesOverride) && input.rulesOverride.length > 0
      ? input.rulesOverride
      : crmState.rules;
  const decision = computeTicketPriority(input.nlu, input.slaTier, activeRules);
  const nowIso = new Date().toISOString();
  const connector = crmState.connectors.find((c) => c.platform === input.platform);
  const shouldAutoSync = connector ? connector.connected && connector.autoSync : true;
  const bookedLang = normalizeLanguageName(input.activeLanguage || input.nlu.language);

  let ticket = input.activeTicketId
    ? crmState.tickets.find((t) => t.id === input.activeTicketId)
    : undefined;

  if (!ticket && input.existingTicket && input.existingTicket.id === input.activeTicketId) {
    ticket = { ...input.existingTicket, tags: [...input.existingTicket.tags] };
    crmState.tickets.unshift(ticket);
  }

  if (ticket) {
    ticket.intent = input.nlu.intent;
    ticket.sentiment = input.nlu.sentiment;
    ticket.sentimentScore = input.nlu.sentimentScore;
    ticket.priority = decision.priority;
    ticket.zendeskPriority = decision.zendeskPriority;
    ticket.slaMinutes = decision.slaMinutes;
    const mergedTags = Array.from(new Set([...ticket.tags, ...decision.tags]));
    ticket.tags = bookedLang ? upsertLanguageTag(mergedTags, bookedLang) : mergedTags;
    ticket.status = decision.escalated ? 'Escalated' : 'In Progress';
    ticket.syncStatus = shouldAutoSync ? 'Synced' : 'Pending';
    ticket.lastSyncedAt = shouldAutoSync ? nowIso : ticket.lastSyncedAt;
    ticket.avgLatencyMs = Math.round((ticket.avgLatencyMs + input.latencyMs) / 2);
    ticket.summary = input.nlu.summary;
  } else {
    crmState.sequence += 1;
    const baseTags = bookedLang ? upsertLanguageTag(decision.tags, bookedLang) : decision.tags;
    ticket = {
      id: `tkt-${Date.now().toString(36)}-${crmState.sequence}`,
      externalId: generateExternalTicketId(input.platform, crmState.sequence),
      platform: input.platform,
      customerName: input.customerName,
      company: input.company,
      customerEmail: input.customerEmail,
      slaTier: input.slaTier,
      subject: input.subject,
      intent: input.nlu.intent,
      sentiment: input.nlu.sentiment,
      sentimentScore: input.nlu.sentimentScore,
      priority: decision.priority,
      zendeskPriority: decision.zendeskPriority,
      slaMinutes: decision.slaMinutes,
      tags: baseTags,
      status: decision.escalated ? 'Escalated' : 'New',
      syncStatus: shouldAutoSync ? 'Synced' : 'Pending',
      lastSyncedAt: shouldAutoSync ? nowIso : '',
      avgLatencyMs: input.latencyMs,
      summary: input.nlu.summary,
      createdAt: nowIso,
    };
    crmState.tickets.unshift(ticket);
    if (connector && shouldAutoSync) {
      connector.ticketsSyncedCount += 1;
      connector.lastSyncAt = nowIso;
    }
  }

  const crmPayload =
    ticket.platform === 'salesforce'
      ? buildSalesforceCasePayload(ticket)
      : buildZendeskTicketPayload(ticket);

  return { ticket, decision, crmPayload };
}

async function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'meridian-voice', timestamp: new Date().toISOString() });
  });

  app.get('/api/crm/state', (_req, res) => {
    res.json({
      tickets: crmState.tickets,
      rules: crmState.rules,
      connectors: crmState.connectors,
    });
  });

  app.post('/api/support/turn', async (req, res) => {
    try {
      const {
        utterance,
        customerName = 'Caller',
        company = 'Enterprise Account',
        customerEmail = 'caller@enterprise.io',
        slaTier = 'Enterprise',
        targetPlatform = 'salesforce',
        history = [],
        activeTicketId,
        existingTicket = null,
        rulesOverride = null,
        lockedLanguage = null,
        switchPending = false,
      } = req.body ?? {};

      if (!utterance || typeof utterance !== 'string' || !utterance.trim()) {
        res.status(400).json({ error: 'Utterance text is required.' });
        return;
      }

      const platform: CrmPlatform = targetPlatform === 'zendesk' ? 'zendesk' : 'salesforce';
      const tier: 'Enterprise' | 'Growth' | 'Standard' =
        slaTier === 'Growth' || slaTier === 'Standard' ? slaTier : 'Enterprise';

      const result = await runLowLatencyNluTurn({
        utterance: utterance.trim(),
        customerName,
        company,
        slaTier: tier,
        history,
        lockedLanguage,
        switchPending: Boolean(switchPending),
      });

      const { ticket, decision, crmPayload } = upsertCrmTicketFromAnalysis({
        activeTicketId,
        platform,
        customerName,
        company,
        customerEmail,
        slaTier: tier,
        subject: result.subject,
        nlu: result.nlu,
        latencyMs: result.latencyMs,
        activeLanguage: result.activeLanguage,
        existingTicket,
        rulesOverride,
      });

      const previousLanguage = normalizeLanguageName(lockedLanguage);
      const languageChangedEvent = result.languageSwitched
        ? {
            type: 'language_changed' as const,
            previousLanguage,
            activeLanguage: result.activeLanguage,
            reason: 'explicit_switch' as const,
            transitionMessage: buildLanguageTransitionMessage(
              previousLanguage,
              result.activeLanguage
            ),
          }
        : undefined;

      res.json({
        reply: result.reply,
        latencyMs: result.latencyMs,
        nlu: result.nlu,
        triage: decision,
        ticket,
        crmPayload,
        activeLanguage: result.activeLanguage,
        languageSwitched: result.languageSwitched,
        switchPending: result.switchPending,
        languageChangedEvent,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to process support turn.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/voice/speak', async (req, res) => {
    try {
      const { text, voiceName = 'Zephyr' } = req.body ?? {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        res.status(400).json({ error: 'Text is required.' });
        return;
      }
      const validVoice: VoicePersona = ['Zephyr', 'Kore', 'Fenrir', 'Puck'].includes(voiceName)
        ? voiceName
        : 'Zephyr';
      const audioChunks: string[] = [];
      const synth = await synthesizeBridgeTtsChunks(text.trim(), validVoice, (chunk) => {
        audioChunks.push(chunk);
      });
      res.json({
        audioChunks,
        wavBase64: synth.wavBase64,
        fallback: !synth.ok || (audioChunks.length === 0 && !synth.wavBase64),
        reason: synth.ok ? undefined : synth.error,
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      res.json({ audioChunks: [], fallback: true, reason });
    }
  });

  app.patch('/api/crm/tickets/:id', (req, res) => {
    const ticket = crmState.tickets.find((t) => t.id === req.params.id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found.' });
      return;
    }

    const { status, priority, tags } = req.body ?? {};
    if (status && ['New', 'In Progress', 'Escalated', 'Resolved'].includes(status)) {
      ticket.status = status;
    }
    if (priority && ['P1', 'P2', 'P3', 'P4'].includes(priority)) {
      ticket.priority = priority;
      ticket.zendeskPriority =
        priority === 'P1'
          ? 'urgent'
          : priority === 'P2'
          ? 'high'
          : priority === 'P3'
          ? 'normal'
          : 'low';
    }
    if (Array.isArray(tags)) {
      ticket.tags = tags.map((t) => String(t).trim()).filter(Boolean);
    }

    res.json({ ticket });
  });

  app.post('/api/crm/tickets/:id/sync', (req, res) => {
    const ticket = crmState.tickets.find((t) => t.id === req.params.id);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found.' });
      return;
    }

    const nowIso = new Date().toISOString();
    ticket.syncStatus = 'Synced';
    ticket.lastSyncedAt = nowIso;

    const connector = crmState.connectors.find((c) => c.platform === ticket.platform);
    if (connector) {
      connector.lastSyncAt = nowIso;
      connector.ticketsSyncedCount += 1;
    }

    const crmPayload =
      ticket.platform === 'salesforce'
        ? buildSalesforceCasePayload(ticket)
        : buildZendeskTicketPayload(ticket);

    res.json({ ticket, crmPayload, connector });
  });

  app.put('/api/crm/rules/:id', (req, res) => {
    const rule = crmState.rules.find((r) => r.id === req.params.id);
    if (!rule) {
      res.status(404).json({ error: 'Triage rule not found.' });
      return;
    }

    const { enabled, assignPriority, maxSentimentScore, slaMinutes, escalateToTier2, autoTags } =
      req.body ?? {};

    if (typeof enabled === 'boolean') rule.enabled = enabled;
    if (assignPriority && ['P1', 'P2', 'P3', 'P4'].includes(assignPriority)) {
      rule.assignPriority = assignPriority;
    }
    if (typeof maxSentimentScore === 'number' && !Number.isNaN(maxSentimentScore)) {
      rule.maxSentimentScore = Math.min(1, Math.max(-1, maxSentimentScore));
    }
    if (typeof slaMinutes === 'number' && slaMinutes > 0) {
      rule.slaMinutes = Math.round(slaMinutes);
    }
    if (typeof escalateToTier2 === 'boolean') {
      rule.escalateToTier2 = escalateToTier2;
    }
    if (Array.isArray(autoTags)) {
      rule.autoTags = autoTags.map((t) => String(t).trim()).filter(Boolean);
    }

    res.json({ rule });
  });

  app.put('/api/crm/connectors/:platform', (req, res) => {
    const connector = crmState.connectors.find((c) => c.platform === req.params.platform);
    if (!connector) {
      res.status(404).json({ error: 'Connector not found.' });
      return;
    }

    const { connected, instanceUrl, autoSync, defaultQueue } = req.body ?? {};
    if (typeof connected === 'boolean') connector.connected = connected;
    if (typeof instanceUrl === 'string' && instanceUrl.trim()) {
      connector.instanceUrl = instanceUrl.trim();
    }
    if (typeof autoSync === 'boolean') connector.autoSync = autoSync;
    if (typeof defaultQueue === 'string' && defaultQueue.trim()) {
      connector.defaultQueue = defaultQueue.trim();
    }

    res.json({ connector });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url ?? '/', `http://${request.headers.host}`);
    if (reqUrl.pathname === '/api/live-voice') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (clientWs: WebSocket, req) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const voiceParam = url.searchParams.get('voice') as VoicePersona | null;
    const voiceName: VoicePersona =
      voiceParam && ['Zephyr', 'Kore', 'Fenrir', 'Puck'].includes(voiceParam)
        ? voiceParam
        : 'Zephyr';
    const platformParam: CrmPlatform =
      url.searchParams.get('platform') === 'zendesk' ? 'zendesk' : 'salesforce';
    const customerName = url.searchParams.get('customerName') || 'Live Voice Caller';
    const company = url.searchParams.get('company') || 'Enterprise Caller';
    const customerEmail = url.searchParams.get('customerEmail') || 'voice-caller@enterprise.io';
    const slaTierParam = url.searchParams.get('slaTier');
    const slaTier: 'Enterprise' | 'Growth' | 'Standard' =
      slaTierParam === 'Growth' || slaTierParam === 'Standard' ? slaTierParam : 'Enterprise';
    const initialLanguageParam = url.searchParams.get('language');

    let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let bridgeMode = false;
    const bridgeHistory: Array<{ speaker: string; text: string }> = [];
    const bridgeVad = new UtteranceVadAccumulator({
      sampleRate: 16000,
      speechThresholdRms: 0.008,
      silenceFlushMs: 900,
      minSpeechMs: 320,
      maxUtteranceMs: 15000,
    });
    let bridgeQueue: Promise<void> = Promise.resolve();
    let lastUserActivityAt = performance.now();
    let awaitingFirstAudioChunk = false;
    let activeTicketId: string | undefined;
    let activeLanguage: string | null = normalizeLanguageName(initialLanguageParam);
    let switchPending = false;
    let callerStreamBuffer = '';
    let callerTurnActive = false;
    let switchEmittedForCurrentTurn = false;

    const applyAndEmitLanguageChange = (params: {
      nextLanguage: string;
      reason:
        | 'mid_stream_detected'
        | 'caller_requested_switch'
        | 'operator_selected'
        | 'initial_lock';
    }) => {
      const prev = activeLanguage;
      const normalizedNext = normalizeLanguageName(params.nextLanguage) || params.nextLanguage;
      const changed = prev !== normalizedNext;

      activeLanguage = normalizedNext;
      switchPending = false;

      let updatedTicket: CrmTicket | undefined;
      if (activeTicketId) {
        const found = crmState.tickets.find((t) => t.id === activeTicketId);
        if (found) {
          found.tags = upsertLanguageTag(found.tags, normalizedNext);
          updatedTicket = found;
        }
      }

      if (clientWs.readyState !== WebSocket.OPEN) return;

      const shouldEmitChangeEvent =
        (changed && prev !== null) ||
        params.reason === 'mid_stream_detected' ||
        params.reason === 'caller_requested_switch';

      if (shouldEmitChangeEvent && changed) {
        const transitionMessage = buildLanguageTransitionMessage(prev, normalizedNext);
        clientWs.send(
          JSON.stringify({
            type: 'language_changed',
            previousLanguage: prev,
            activeLanguage: normalizedNext,
            reason: params.reason,
            transitionMessage,
            ticket: updatedTicket,
          })
        );
      } else {
        clientWs.send(
          JSON.stringify({
            type: 'language_updated',
            activeLanguage: normalizedNext,
            switched: false,
            ticket: updatedTicket,
          })
        );
      }
    };

    const tagCrmTicketTool: FunctionDeclaration = {
      name: 'tagCrmTicket',
      description:
        'Creates or updates a customer support ticket in Salesforce or Zendesk with NLU intent, sentiment score, and automatic priority tags.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: 'Concise ticket subject' },
          intent: {
            type: Type.STRING,
            description:
              'outage_escalation, billing_dispute, sso_configuration, account_renewal, or general_inquiry',
          },
          sentimentScore: {
            type: Type.NUMBER,
            description: 'Sentiment valence from -1.0 to 1.0',
          },
          emotion: { type: Type.STRING },
          urgencySignals: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          summary: { type: Type.STRING },
        },
        required: ['subject', 'intent', 'sentimentScore', 'summary'],
      },
    };

    const setConversationLanguageTool: FunctionDeclaration = {
      name: 'setConversationLanguage',
      description:
        'Books and locks the single conversation language for this support call. Call on the caller’s first turn to lock their spoken language (unless already locked), and call again ONLY when the caller explicitly asks to switch to a different language.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          language: {
            type: Type.STRING,
            description:
              'Canonical language name such as English, Hindi, Hinglish, Spanish, French, German, Marathi, Tamil, Telugu, Bengali, Arabic, or Japanese.',
          },
          reason: {
            type: Type.STRING,
            description: 'caller_initial_language or caller_requested_switch',
          },
        },
        required: ['language', 'reason'],
      },
    };

    const languagePolicyInstruction = activeLanguage
      ? `The caller's session is currently BOOKED and LOCKED to ${activeLanguage}. Speak exclusively in ${activeLanguage} for the entire topic, even if English technical terms (API, 502, SLA, CRM, invoice) are used. Only switch languages if the caller explicitly asks to speak in a different language.`
      : `On the caller's very first utterance, detect their spoken language, immediately call setConversationLanguage(language, "caller_initial_language"), and speak exclusively in that single language for the entire topic. Never revert to or repeat English when the caller speaks another language (such as Hindi), even if technical terms like API, 502, SLA, or CRM appear.`;

    const connectLiveSession = async (apiVersion: 'v1beta' | 'v1alpha') => {
      const ai = getGeminiClient(apiVersion);
      return ai.live.connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } },
          },
          tools: [{ functionDeclarations: [tagCrmTicketTool, setConversationLanguageTool] }],
          systemInstruction: `You are Meridian Voice AI, a calm, ultra-responsive multilingual voice assistant and customer support agent speaking with ${customerName} from ${company} (${slaTier} SLA).
Answer ANY question, greeting, everyday conversation, or support issue the caller brings up clearly and helpfully. Keep spoken replies crisp (1-2 sentences) for low latency.

LANGUAGE CONTINUITY & SWITCHING POLICY:
${languagePolicyInstruction}
- Do NOT flip-flop languages mid-topic and do NOT repeat a default language if the caller is speaking another language.
- ONLY switch languages when the caller explicitly asks to talk in another language (e.g. "I want to talk in English", "मुझे किसी और लैंग्वेज में बात करनी है", "switch to Spanish").
- If the caller asks to change language without naming which one, ask concisely in the current language which language they want. Once they name the new language, immediately call setConversationLanguage(language, "caller_requested_switch") to book that new language, switch completely, and continue the rest of the conversation exclusively in that new language.

Whenever the caller states an issue, asks a question worth logging, sentiment shifts, or an escalation occurs, invoke tagCrmTicket to log and auto-tag the ${platformParam} ticket.`,
        },
        callbacks: {
          onopen: () => {
            // Wait until setupComplete resolves connectLiveSession before signaling ready to client
          },
          onmessage: async (message: LiveServerMessage) => {
            if (clientWs.readyState !== WebSocket.OPEN) return;

            const content = message.serverContent;
            if (content?.inputTranscription?.text) {
              const transcriptText = content.inputTranscription.text;
              lastUserActivityAt = performance.now();
              awaitingFirstAudioChunk = true;

              if (!callerTurnActive) {
                callerTurnActive = true;
                callerStreamBuffer = '';
                switchEmittedForCurrentTurn = false;
              }
              callerStreamBuffer = mergeTranscriptChunk(callerStreamBuffer, transcriptText);

              clientWs.send(
                JSON.stringify({ type: 'input_transcript', text: transcriptText })
              );

              if (!switchEmittedForCurrentTurn) {
                const midStream = detectMidStreamLanguageSwitch(callerStreamBuffer, {
                  currentLanguage: activeLanguage,
                  switchPending,
                });
                if (midStream.switched && midStream.nextLanguage) {
                  applyAndEmitLanguageChange({
                    nextLanguage: midStream.nextLanguage,
                    reason: 'mid_stream_detected',
                  });
                  switchEmittedForCurrentTurn = true;
                  callerStreamBuffer = '';
                } else if (midStream.switchPending) {
                  switchPending = true;
                }
              }
            }

            if (content?.outputTranscription?.text) {
              callerTurnActive = false;
              callerStreamBuffer = '';
              switchEmittedForCurrentTurn = false;
              clientWs.send(
                JSON.stringify({ type: 'output_transcript', text: content.outputTranscription.text })
              );
            }

            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
                callerTurnActive = false;
                callerStreamBuffer = '';
                switchEmittedForCurrentTurn = false;
                let latencyMs: number | undefined;
                if (awaitingFirstAudioChunk) {
                  latencyMs = Math.max(1, Math.round(performance.now() - lastUserActivityAt));
                  awaitingFirstAudioChunk = false;
                }
                clientWs.send(
                  JSON.stringify({
                    type: 'audio',
                    data: part.inlineData.data,
                    latencyMs,
                  })
                );
              }
            }

            if (content?.interrupted) {
              clientWs.send(JSON.stringify({ type: 'interrupted' }));
            }

            for (const call of message.toolCall?.functionCalls ?? []) {
              if (call.name === 'setConversationLanguage') {
                const args = (call.args ?? {}) as Record<string, unknown>;
                const requestedLang = normalizeLanguageName(String(args.language || ''));
                const resolution = resolveConversationLanguage({
                  currentLockedLanguage: activeLanguage,
                  detectedInputLanguage: requestedLang,
                  explicitRequestedLanguage:
                    args.reason === 'caller_requested_switch' ? requestedLang : null,
                  switchPending: false,
                });

                const alreadyHandledMidStream =
                  switchEmittedForCurrentTurn && activeLanguage === resolution.activeLanguage;

                if (!alreadyHandledMidStream) {
                  applyAndEmitLanguageChange({
                    nextLanguage: resolution.activeLanguage,
                    reason:
                      args.reason === 'caller_requested_switch'
                        ? 'caller_requested_switch'
                        : 'initial_lock',
                  });
                  if (args.reason === 'caller_requested_switch') {
                    switchEmittedForCurrentTurn = true;
                  }
                }

                session?.sendToolResponse({
                  functionResponses: [
                    {
                      id: call.id,
                      name: call.name,
                      response: {
                        bookedLanguage: activeLanguage,
                        instruction: `Session language is now booked to ${activeLanguage}. Continue speaking exclusively in ${activeLanguage} until the caller explicitly asks to switch.`,
                      },
                    },
                  ],
                });
              } else if (call.name === 'tagCrmTicket') {
                const args = (call.args ?? {}) as Record<string, unknown>;
                const score = Number(args.sentimentScore ?? 0);
                const sentiment: NluAnalysis['sentiment'] =
                  score <= -0.3 ? 'Negative' : score < 0.15 ? 'Mixed' : score >= 0.45 ? 'Positive' : 'Neutral';

                const nlu: NluAnalysis = {
                  intent: String(args.intent || 'general_inquiry'),
                  confidence: 0.94,
                  sentiment,
                  sentimentScore: Math.min(1, Math.max(-1, score)),
                  emotion: String(args.emotion || (score < -0.3 ? 'Frustrated' : 'Calm')),
                  urgencySignals: Array.isArray(args.urgencySignals)
                    ? args.urgencySignals.map(String)
                    : [],
                  entities: [],
                  summary: String(args.summary || 'Live voice call ticket logged.'),
                  language: activeLanguage ?? undefined,
                };

                const { ticket, decision, crmPayload } = upsertCrmTicketFromAnalysis({
                  activeTicketId,
                  platform: platformParam,
                  customerName,
                  company,
                  customerEmail,
                  slaTier,
                  subject: String(args.subject || 'Live Voice Support Case'),
                  nlu,
                  latencyMs: 185,
                  activeLanguage,
                });

                activeTicketId = ticket.id;

                clientWs.send(
                  JSON.stringify({
                    type: 'crm_ticket_updated',
                    nlu,
                    triage: decision,
                    ticket,
                    crmPayload,
                  })
                );

                session?.sendToolResponse({
                  functionResponses: [
                    {
                      id: call.id,
                      name: call.name,
                      response: {
                        externalId: ticket.externalId,
                        priority: ticket.priority,
                        tags: ticket.tags,
                        status: ticket.status,
                      },
                    },
                  ],
                });
              }
            }
          },
          onerror: (err: unknown) => {
            if (session && isLiveApiQuotaOrUnavailableError(err)) {
              const oldSession = session;
              session = null;
              bridgeMode = true;
              try {
                oldSession.close();
              } catch {
                // Ignore close error on failing session
              }
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: 'ready',
                    voiceName,
                    platform: platformParam,
                    activeLanguage,
                    mode: 'bridge',
                    notice:
                      'Gemini Live Bidi quota reached — switched seamlessly to Voice Bridge (16kHz mic -> NLU -> 24kHz voice audio).',
                  })
                );
              }
              return;
            }
            // Only forward non-quota error once session setup has completed; setup errors reject connect()
            if (session && clientWs.readyState === WebSocket.OPEN) {
              const msg = err instanceof Error ? err.message : 'Gemini Live API error';
              clientWs.send(JSON.stringify({ type: 'error', error: msg }));
            }
          },
          onclose: (ev?: { code?: number; reason?: string }) => {
            if (!bridgeMode && session) {
              const reasonText = ev?.reason || `code ${ev?.code ?? ''}`;
              if (ev?.code === 1011 || isLiveApiQuotaOrUnavailableError(reasonText)) {
                session = null;
                bridgeMode = true;
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'ready',
                      voiceName,
                      platform: platformParam,
                      activeLanguage,
                      mode: 'bridge',
                      notice:
                        'Gemini Live Bidi quota reached — switched seamlessly to Voice Bridge (16kHz mic -> NLU -> 24kHz voice audio).',
                    })
                  );
                }
                return;
              }
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'closed', reason: reasonText }));
              }
            }
          },
        },
      });
    };

    const runBridgeTurn = async (params: { utterance: string; emitInputTranscript: boolean; startedAt: number }) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      const cleanUtterance = params.utterance.trim();
      if (!cleanUtterance) return;

      if (params.emitInputTranscript) {
        clientWs.send(JSON.stringify({ type: 'input_transcript', text: cleanUtterance }));
      }

      const previousLang = activeLanguage;
      const midStream = detectMidStreamLanguageSwitch(cleanUtterance, {
        currentLanguage: activeLanguage,
        switchPending,
      });

      const nluResult = await runLowLatencyNluTurn({
        utterance: cleanUtterance,
        customerName,
        company,
        slaTier,
        history: bridgeHistory,
        lockedLanguage: activeLanguage,
        switchPending: midStream.switchPending || switchPending,
      });

      bridgeHistory.push({ speaker: 'caller', text: cleanUtterance });
      bridgeHistory.push({ speaker: 'agent', text: nluResult.reply });

      const prevForEvent = previousLang;
      activeLanguage = nluResult.activeLanguage;
      switchPending = nluResult.switchPending;

      if (nluResult.languageSwitched) {
        applyAndEmitLanguageChange({
          nextLanguage: nluResult.activeLanguage,
          reason: 'caller_requested_switch',
        });
      } else if (!prevForEvent && nluResult.activeLanguage) {
        applyAndEmitLanguageChange({
          nextLanguage: nluResult.activeLanguage,
          reason: 'initial_lock',
        });
      }

      const latencyMs = Math.max(1, Math.round(performance.now() - params.startedAt));
      const { ticket, decision, crmPayload } = upsertCrmTicketFromAnalysis({
        activeTicketId,
        platform: platformParam,
        customerName,
        company,
        customerEmail,
        slaTier,
        subject: nluResult.subject,
        nlu: nluResult.nlu,
        latencyMs,
        activeLanguage,
      });
      activeTicketId = ticket.id;

      if (clientWs.readyState !== WebSocket.OPEN) return;

      clientWs.send(
        JSON.stringify({
          type: 'crm_ticket_updated',
          nlu: nluResult.nlu,
          triage: decision,
          ticket,
          crmPayload,
        })
      );

      clientWs.send(
        JSON.stringify({
          type: 'output_transcript',
          text: nluResult.reply,
          latencyMs,
        })
      );

      let firstChunk = true;
      const ttsResult = await synthesizeBridgeTtsChunks(nluResult.reply, voiceName, (data) => {
        if (clientWs.readyState !== WebSocket.OPEN) return;
        const audioLatency = firstChunk
          ? Math.max(1, Math.round(performance.now() - params.startedAt))
          : undefined;
        firstChunk = false;
        clientWs.send(
          JSON.stringify({
            type: 'audio',
            data,
            latencyMs: audioLatency,
          })
        );
      });

      if (!ttsResult.ok && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'speak_fallback',
            text: nluResult.reply,
            language: activeLanguage,
            latencyMs,
          })
        );
      }
    };

    const enqueueBridgeAudio = (pcmBuffer: Buffer) => {
      const startedAt = performance.now();
      bridgeQueue = bridgeQueue
        .then(async () => {
          if (clientWs.readyState !== WebSocket.OPEN) return;
          const wav = encodePcm16ToWav(pcmBuffer, 16000, 1);
          const transcript = await transcribeBridgeWav(wav);
          if (!transcript) return;
          await runBridgeTurn({ utterance: transcript, emitInputTranscript: true, startedAt });
        })
        .catch((err) => {
          console.error('[VoiceBridge] Audio turn error:', err);
        });
    };

    try {
      try {
        session = await connectLiveSession('v1alpha');
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : '';
        console.warn('[LiveVoice] v1alpha connect attempt failed:', msg);
        session = await connectLiveSession('v1beta');
      }
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(
          JSON.stringify({
            type: 'ready',
            voiceName,
            platform: platformParam,
            activeLanguage,
            mode: 'live',
          })
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to start live voice session.';
      console.error('[LiveVoice] Live connection failed:', msg, {
        hasBaseUrlOverride: Boolean(process.env.GOOGLE_GEMINI_BASE_URL),
      });

      if (isLiveApiQuotaOrUnavailableError(err)) {
        bridgeMode = true;
        session = null;
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(
            JSON.stringify({
              type: 'ready',
              voiceName,
              platform: platformParam,
              activeLanguage,
              mode: 'bridge',
              notice:
                'Gemini Live Bidi quota reached — switched seamlessly to Voice Bridge (16kHz mic -> NLU -> 24kHz voice audio).',
            })
          );
        }
      } else {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'error', error: msg }));
          clientWs.close();
        }
        return;
      }
    }

    clientWs.on('message', (raw) => {
      if (!session && !bridgeMode) return;
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          audio?: string;
          text?: string;
          language?: string;
        };
        if (msg.type === 'set_language' && msg.language) {
          const nextLang = normalizeLanguageName(msg.language);
          if (nextLang) {
            applyAndEmitLanguageChange({
              nextLanguage: nextLang,
              reason: 'operator_selected',
            });
            if (session) {
              session.sendClientContent({
                turns: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: `[System update: The caller switched the booked conversation language to ${nextLang}. From now on, reply exclusively in ${nextLang} and continue the topic in ${nextLang}.]`,
                      },
                    ],
                  },
                ],
                turnComplete: true,
              });
            }
          } else {
            activeLanguage = null;
          }
        } else if (msg.type === 'flush_audio' && bridgeMode) {
          const pending = bridgeVad.flush();
          if (pending) {
            enqueueBridgeAudio(pending);
          }
        } else if (msg.audio) {
          if (bridgeMode) {
            const pcmBuffer = Buffer.from(msg.audio, 'base64');
            const utterancePcm = bridgeVad.pushChunk(pcmBuffer);
            if (utterancePcm) {
              enqueueBridgeAudio(utterancePcm);
            }
          } else if (session) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
            });
          }
        } else if (msg.text) {
          if (bridgeMode) {
            const startedAt = performance.now();
            bridgeQueue = bridgeQueue
              .then(() =>
                runBridgeTurn({
                  utterance: msg.text!,
                  emitInputTranscript: true,
                  startedAt,
                })
              )
              .catch((err) => {
                console.error('[VoiceBridge] Text turn error:', err);
              });
          } else if (session) {
            lastUserActivityAt = performance.now();
            awaitingFirstAudioChunk = true;
            callerTurnActive = false;
            callerStreamBuffer = '';
            switchEmittedForCurrentTurn = false;

            const midStream = detectMidStreamLanguageSwitch(msg.text, {
              currentLanguage: activeLanguage,
              switchPending,
            });
            const scriptHint = detectScriptLanguageHint(msg.text);

            if (midStream.switched && midStream.nextLanguage) {
              applyAndEmitLanguageChange({
                nextLanguage: midStream.nextLanguage,
                reason: 'mid_stream_detected',
              });
              switchEmittedForCurrentTurn = true;
            } else if (midStream.switchPending) {
              switchPending = true;
            } else if (!activeLanguage && scriptHint) {
              applyAndEmitLanguageChange({
                nextLanguage: scriptHint,
                reason: 'initial_lock',
              });
            }

            const directiveNote = midStream.nextLanguage
              ? `\n[System: Caller explicitly booked ${midStream.nextLanguage}. Reply exclusively in ${midStream.nextLanguage}.]`
              : midStream.switchPending
              ? `\n[System: Caller asked to switch languages without naming one. Ask concisely which language they want.]`
              : activeLanguage
              ? `\n[System: Continue strictly in locked language: ${activeLanguage}.]`
              : '';

            session.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: `${msg.text}${directiveNote}` }] }],
              turnComplete: true,
            });
          }
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    clientWs.on('close', () => {
      bridgeVad.reset();
      try {
        session?.close();
      } catch {
        // Ignore close errors
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Meridian Voice server running at http://localhost:${PORT}`);
  });
}

createApp();
