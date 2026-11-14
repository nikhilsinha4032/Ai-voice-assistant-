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
  ],
};

async function runLowLatencyNluTurn(params: {
  utterance: string;
  customerName: string;
  company: string;
  slaTier: 'Enterprise' | 'Growth' | 'Standard';
  history: Array<{ speaker: string; text: string }>;
}) {
  const ai = getGeminiClient();
  const startedAt = performance.now();

  const historyBlock = params.history
    .slice(-6)
    .map((h) => `${h.speaker === 'caller' ? 'Caller' : 'Agent'}: ${h.text}`)
    .join('\n');

  const prompt = `Customer Profile: ${params.customerName} (${params.company}, SLA Tier: ${params.slaTier})
Recent Transcript:
${historyBlock || '(Start of call)'}

Latest Caller Utterance:
"${params.utterance}"

Analyze intent, sentiment (-1.0 to 1.0), emotion, urgency signals, and entities, and craft a crisp, helpful spoken-style support response.`;

  const response = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: prompt,
    config: {
      systemInstruction:
        'You are Meridian Voice AI, a low-latency enterprise customer support agent. Respond concisely in 1-3 natural spoken sentences, acknowledge emotion empathetically, and extract accurate NLU & sentiment JSON.',
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      responseMimeType: 'application/json',
      responseSchema: nluResponseSchema,
    },
  });

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
  };

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
  };

  return {
    reply: parsed.reply,
    subject: parsed.subject || 'Support Voice Escalation',
    nlu,
    latencyMs,
  };
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
}) {
  const decision = computeTicketPriority(input.nlu, input.slaTier, crmState.rules);
  const nowIso = new Date().toISOString();
  const connector = crmState.connectors.find((c) => c.platform === input.platform);
  const shouldAutoSync = connector ? connector.connected && connector.autoSync : true;

  let ticket = input.activeTicketId
    ? crmState.tickets.find((t) => t.id === input.activeTicketId)
    : undefined;

  if (ticket) {
    ticket.intent = input.nlu.intent;
    ticket.sentiment = input.nlu.sentiment;
    ticket.sentimentScore = input.nlu.sentimentScore;
    ticket.priority = decision.priority;
    ticket.zendeskPriority = decision.zendeskPriority;
    ticket.slaMinutes = decision.slaMinutes;
    ticket.tags = Array.from(new Set([...ticket.tags, ...decision.tags]));
    ticket.status = decision.escalated ? 'Escalated' : 'In Progress';
    ticket.syncStatus = shouldAutoSync ? 'Synced' : 'Pending';
    ticket.lastSyncedAt = shouldAutoSync ? nowIso : ticket.lastSyncedAt;
    ticket.avgLatencyMs = Math.round((ticket.avgLatencyMs + input.latencyMs) / 2);
    ticket.summary = input.nlu.summary;
  } else {
    crmState.sequence += 1;
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
      tags: decision.tags,
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
      });

      res.json({
        reply: result.reply,
        latencyMs: result.latencyMs,
        nlu: result.nlu,
        triage: decision,
        ticket,
        crmPayload,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to process support turn.';
      res.status(500).json({ error: message });
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

    let session: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let lastUserActivityAt = performance.now();
    let awaitingFirstAudioChunk = false;
    let activeTicketId: string | undefined;

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
          tools: [{ functionDeclarations: [tagCrmTicketTool] }],
          systemInstruction: `You are Meridian Voice AI, a calm, ultra-responsive enterprise customer support agent speaking with ${customerName} from ${company} (${slaTier} SLA). Keep spoken replies crisp (1-2 sentences) for low latency. Whenever the caller states an issue, sentiment shifts, or an escalation occurs, invoke tagCrmTicket immediately to log and auto-tag the ${platformParam} ticket.`,
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
              clientWs.send(
                JSON.stringify({ type: 'input_transcript', text: transcriptText })
              );
            }

            if (content?.outputTranscription?.text) {
              clientWs.send(
                JSON.stringify({ type: 'output_transcript', text: content.outputTranscription.text })
              );
            }

            for (const part of content?.modelTurn?.parts ?? []) {
              if (part.inlineData?.data) {
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
              if (call.name === 'tagCrmTicket') {
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
            // Only forward error once session setup has completed; setup errors reject connect()
            if (session && clientWs.readyState === WebSocket.OPEN) {
              const msg = err instanceof Error ? err.message : 'Gemini Live API error';
              clientWs.send(JSON.stringify({ type: 'error', error: msg }));
            }
          },
          onclose: () => {
            if (session && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ type: 'closed' }));
            }
          },
        },
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
        clientWs.send(JSON.stringify({ type: 'ready', voiceName, platform: platformParam }));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to start live voice session.';
      console.error('[LiveVoice] Live connection failed:', msg, {
        hasBaseUrlOverride: Boolean(process.env.GOOGLE_GEMINI_BASE_URL),
      });
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', error: msg }));
        clientWs.close();
      }
      return;
    }

    clientWs.on('message', (raw) => {
      if (!session) return;
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          audio?: string;
          text?: string;
        };
        if (msg.audio) {
          session.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (msg.text) {
          lastUserActivityAt = performance.now();
          awaitingFirstAudioChunk = true;
          session.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turnComplete: true,
          });
        }
      } catch {
        // Ignore malformed client frames
      }
    });

    clientWs.on('close', () => {
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
