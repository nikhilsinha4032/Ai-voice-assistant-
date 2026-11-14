import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Inbox,
  SlidersHorizontal,
  Plug,
  Menu,
  X,
  PhoneCall,
  PhoneOff,
} from 'lucide-react';
import type {
  CrmConnectorConfig,
  CrmPlatform,
  CrmTicket,
  NluAnalysis,
  TranscriptTurn,
  TriageRule,
  VoicePersona,
} from './types/support';
import {
  DEFAULT_TRIAGE_RULES,
  INITIAL_CONNECTORS,
  INITIAL_TICKETS,
} from './lib/seedData';
import {
  AudioPlaybackScheduler,
  computeRmsAmplitude,
  float32ToInt16Base64,
} from './utils/audio';
import { LiveCallConsole } from './components/LiveCallConsole';
import { TicketQueueView } from './components/TicketQueueView';
import { TriageRulesView } from './components/TriageRulesView';
import { ConnectorsView } from './components/ConnectorsView';

type ActiveSection = 'console' | 'tickets' | 'rules' | 'connectors';

const NAV_ITEMS: Array<{
  id: ActiveSection;
  label: string;
  icon: typeof AudioLines;
}> = [
  { id: 'console', label: 'Live Call Console', icon: AudioLines },
  { id: 'tickets', label: 'CRM Ticket Queue', icon: Inbox },
  { id: 'rules', label: 'Triage & Tagging', icon: SlidersHorizontal },
  { id: 'connectors', label: 'CRM Connectors', icon: Plug },
];

function formatClockTime(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('console');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [tickets, setTickets] = useState<CrmTicket[]>(INITIAL_TICKETS);
  const [rules, setRules] = useState<TriageRule[]>(DEFAULT_TRIAGE_RULES);
  const [connectors, setConnectors] = useState<CrmConnectorConfig[]>(INITIAL_CONNECTORS);

  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [latestNlu, setLatestNlu] = useState<NluAnalysis | null>(null);
  const [isProcessingTurn, setIsProcessingTurn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Live Voice WebSocket + Web Audio state
  const [voicePersona, setVoicePersona] = useState<VoicePersona>('Zephyr');
  const [isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [audioAmplitude, setAudioAmplitude] = useState(0);

  // Refs for audio callbacks to avoid stale closures
  const isMicMutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackRef = useRef<AudioPlaybackScheduler | null>(null);
  const lastLiveTurnIdRef = useRef<{ caller?: string; agent?: string }>({});

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
  }, [isMicMuted]);

  // Fetch live backend CRM state on mount
  const fetchCrmState = useCallback(async () => {
    try {
      const res = await fetch('/api/crm/state');
      if (!res.ok) return;
      const data = (await res.json()) as {
        tickets?: CrmTicket[];
        rules?: TriageRule[];
        connectors?: CrmConnectorConfig[];
      };
      if (data.tickets) setTickets(data.tickets);
      if (data.rules) setRules(data.rules);
      if (data.connectors) setConnectors(data.connectors);
    } catch {
      // Initial seed state remains available
    }
  }, []);

  useEffect(() => {
    void fetchCrmState();
  }, [fetchCrmState]);

  const stopVoiceSession = useCallback(async () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      await inputAudioCtxRef.current.close().catch(() => undefined);
      inputAudioCtxRef.current = null;
    }
    if (playbackRef.current) {
      await playbackRef.current.close().catch(() => undefined);
      playbackRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsVoiceConnected(false);
    setIsAgentSpeaking(false);
    setAudioAmplitude(0);
  }, []);

  useEffect(() => {
    return () => {
      void stopVoiceSession();
    };
  }, [stopVoiceSession]);

  const startVoiceSession = async (context: {
    customerName: string;
    company: string;
    customerEmail: string;
    slaTier: 'Enterprise' | 'Growth' | 'Standard';
    platform: CrmPlatform;
  }) => {
    setErrorMessage(null);
    if (isVoiceConnected) {
      await stopVoiceSession();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;

      const playback = new AudioPlaybackScheduler();
      playback.ensureContext();
      playbackRef.current = playback;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({
        voice: voicePersona,
        platform: context.platform,
        customerName: context.customerName,
        company: context.company,
        customerEmail: context.customerEmail,
        slaTier: context.slaTier,
      });

      const ws = new WebSocket(`${protocol}//${window.location.host}/api/live-voice?${qs.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsVoiceConnected(true);
        const source = inputCtx.createMediaStreamSource(stream);
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (event) => {
          if (isMicMutedRef.current || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          const samples = event.inputBuffer.getChannelData(0);
          const rms = computeRmsAmplitude(samples);
          setAudioAmplitude(rms);
          const base64Audio = float32ToInt16Base64(samples);
          ws.send(JSON.stringify({ audio: base64Audio }));
        };

        source.connect(processor);
        processor.connect(inputCtx.destination);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string) as {
          type: string;
          text?: string;
          data?: string;
          latencyMs?: number;
          error?: string;
          nlu?: NluAnalysis;
          ticket?: CrmTicket;
        };

        if (msg.type === 'error') {
          setErrorMessage(msg.error || 'Voice stream encountered an error.');
          void stopVoiceSession();
          return;
        }

        if (msg.type === 'input_transcript' && msg.text) {
          lastLiveTurnIdRef.current.agent = undefined;
          const existingId = lastLiveTurnIdRef.current.caller;
          const timestamp = formatClockTime();
          setTurns((prev) => {
            if (existingId) {
              return prev.map((t) =>
                t.id === existingId ? { ...t, text: `${t.text} ${msg.text}`.trim() } : t
              );
            }
            const newId = `turn-${Date.now()}-caller`;
            lastLiveTurnIdRef.current.caller = newId;
            return [
              ...prev,
              {
                id: newId,
                speaker: 'caller',
                text: msg.text ?? '',
                timestamp,
                channel: 'voice',
              },
            ];
          });
        }

        if (msg.type === 'output_transcript' && msg.text) {
          lastLiveTurnIdRef.current.caller = undefined;
          const existingId = lastLiveTurnIdRef.current.agent;
          const timestamp = formatClockTime();
          setTurns((prev) => {
            if (existingId) {
              return prev.map((t) =>
                t.id === existingId ? { ...t, text: `${t.text} ${msg.text}`.trim() } : t
              );
            }
            const newId = `turn-${Date.now()}-agent`;
            lastLiveTurnIdRef.current.agent = newId;
            return [
              ...prev,
              {
                id: newId,
                speaker: 'agent',
                text: msg.text ?? '',
                timestamp,
                channel: 'voice',
              },
            ];
          });
        }

        if (msg.type === 'audio' && msg.data && playbackRef.current) {
          setIsAgentSpeaking(true);
          const amp = playbackRef.current.enqueuePcm24k(msg.data, () => {
            setIsAgentSpeaking(false);
          });
          setAudioAmplitude(amp);

          if (typeof msg.latencyMs === 'number') {
            const agentTurnId = lastLiveTurnIdRef.current.agent;
            if (agentTurnId) {
              setTurns((prev) =>
                prev.map((t) =>
                  t.id === agentTurnId && typeof t.latencyMs !== 'number'
                    ? { ...t, latencyMs: msg.latencyMs }
                    : t
                )
              );
            }
          }
        }

        if (msg.type === 'interrupted') {
          playbackRef.current?.interrupt();
          setIsAgentSpeaking(false);
        }

        if (msg.type === 'crm_ticket_updated' && msg.ticket) {
          if (msg.nlu) setLatestNlu(msg.nlu);
          setActiveTicketId(msg.ticket.id);
          setTickets((prev) => {
            const exists = prev.some((t) => t.id === msg.ticket!.id);
            return exists
              ? prev.map((t) => (t.id === msg.ticket!.id ? msg.ticket! : t))
              : [msg.ticket!, ...prev];
          });
        }
      };

      ws.onerror = () => {
        setErrorMessage(
          'Live voice WebSocket connection failed. You can still test low-latency NLU & CRM tagging using scenarios or text turns below.'
        );
        void stopVoiceSession();
      };
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Microphone access is unavailable in this browser.';
      setErrorMessage(
        `${msg} Use the Quick Scenarios or Utterance Composer below to run real-time Gemini NLU & CRM triage.`
      );
      await stopVoiceSession();
    }
  };

  const handleSendTurn = async (params: {
    utterance: string;
    customerName: string;
    company: string;
    customerEmail: string;
    slaTier: 'Enterprise' | 'Growth' | 'Standard';
    targetPlatform: CrmPlatform;
  }) => {
    setErrorMessage(null);
    setIsProcessingTurn(true);

    const callerTurn: TranscriptTurn = {
      id: `turn-${Date.now()}-c`,
      speaker: 'caller',
      text: params.utterance,
      timestamp: formatClockTime(),
      channel: 'text',
    };

    const nextHistory = [...turns, callerTurn].map((t) => ({
      speaker: t.speaker,
      text: t.text,
    }));

    setTurns((prev) => [...prev, callerTurn]);

    try {
      const res = await fetch('/api/support/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          utterance: params.utterance,
          customerName: params.customerName,
          company: params.company,
          customerEmail: params.customerEmail,
          slaTier: params.slaTier,
          targetPlatform: params.targetPlatform,
          history: nextHistory,
          activeTicketId,
        }),
      });

      const payload = (await res.json()) as {
        reply?: string;
        latencyMs?: number;
        nlu?: NluAnalysis;
        ticket?: CrmTicket;
        error?: string;
      };

      if (!res.ok) {
        throw new Error(payload.error || 'Failed to process support turn.');
      }

      if (payload.nlu) {
        setLatestNlu(payload.nlu);
      }

      const agentTurn: TranscriptTurn = {
        id: `turn-${Date.now()}-a`,
        speaker: 'agent',
        text: payload.reply || '',
        timestamp: formatClockTime(),
        latencyMs: payload.latencyMs,
        channel: 'text',
      };

      setTurns((prev) =>
        prev
          .map((t) => (t.id === callerTurn.id ? { ...t, nlu: payload.nlu } : t))
          .concat(agentTurn)
      );

      if (payload.ticket) {
        const updatedTicket = payload.ticket;
        setActiveTicketId(updatedTicket.id);
        setTickets((prev) => {
          const exists = prev.some((t) => t.id === updatedTicket.id);
          return exists
            ? prev.map((t) => (t.id === updatedTicket.id ? updatedTicket : t))
            : [updatedTicket, ...prev];
        });
      }
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to reach NLU backend.'
      );
    } finally {
      setIsProcessingTurn(false);
    }
  };

  const handleResetSession = () => {
    setTurns([]);
    setActiveTicketId(null);
    setLatestNlu(null);
    setErrorMessage(null);
  };

  const handleUpdateTicket = async (
    id: string,
    patch: Partial<Pick<CrmTicket, 'status' | 'priority' | 'tags'>>
  ) => {
    const res = await fetch(`/api/crm/tickets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const { ticket } = (await res.json()) as { ticket: CrmTicket };
      setTickets((prev) => prev.map((t) => (t.id === ticket.id ? ticket : t)));
    }
  };

  const handleSyncTicket = async (id: string) => {
    const res = await fetch(`/api/crm/tickets/${id}/sync`, {
      method: 'POST',
    });
    if (res.ok) {
      const { ticket, connector } = (await res.json()) as {
        ticket: CrmTicket;
        connector?: CrmConnectorConfig;
      };
      setTickets((prev) => prev.map((t) => (t.id === ticket.id ? ticket : t)));
      if (connector) {
        setConnectors((prev) =>
          prev.map((c) => (c.platform === connector.platform ? connector : c))
        );
      }
    }
  };

  const handleSaveRule = async (id: string, patch: Partial<TriageRule>) => {
    const res = await fetch(`/api/crm/rules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const { rule } = (await res.json()) as { rule: TriageRule };
      setRules((prev) => prev.map((r) => (r.id === rule.id ? rule : r)));
    }
  };

  const handleSaveConnector = async (
    platform: CrmPlatform,
    patch: Partial<CrmConnectorConfig>
  ) => {
    const res = await fetch(`/api/crm/connectors/${platform}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      const { connector } = (await res.json()) as { connector: CrmConnectorConfig };
      setConnectors((prev) =>
        prev.map((c) => (c.platform === connector.platform ? connector : c))
      );
    }
  };

  const activeTicket = tickets.find((t) => t.id === activeTicketId) ?? null;
  const activeNavLabel =
    NAV_ITEMS.find((item) => item.id === activeSection)?.label ?? 'Live Call Console';

  return (
    <div className="min-h-screen flex bg-slate-50 text-slate-900">
      {/* Desktop Sidebar (248px) */}
      <aside className="hidden md:flex md:w-[248px] md:shrink-0 md:flex-col bg-white border-r border-slate-200">
        <div className="h-14 px-5 flex items-center border-b border-slate-200">
          <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
            Meridian Voice
          </span>
        </div>

        <nav aria-label="Workspace sections" className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 ${active ? 'text-blue-600' : 'text-slate-400'}`}
                  />
                  {item.label}
                </span>
                {item.id === 'tickets' && (
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {tickets.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-2 text-xs text-slate-500">
          <div className="font-medium text-slate-700">CRM Sync Bridges</div>
          {connectors.map((c) => (
            <div key={c.platform} className="flex items-center justify-between">
              <span>{c.platform === 'salesforce' ? 'Salesforce' : 'Zendesk'}</span>
              <span
                className={`font-medium ${
                  c.connected ? 'text-emerald-700' : 'text-slate-400'
                }`}
              >
                {c.connected ? 'Connected' : 'Paused'}
              </span>
            </div>
          ))}
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 bg-white h-full border-r border-slate-200 flex flex-col z-50">
            <div className="h-14 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-base font-bold text-slate-900">Meridian Voice</span>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav aria-label="Mobile sections" className="p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveSection(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium rounded-md ${
                      active ? 'bg-slate-100 text-slate-900' : 'text-slate-600'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Workspace Header */}
        <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation menu"
              onClick={() => setMobileMenuOpen(true)}
              className="md:hidden p-1.5 -ml-1.5 text-slate-600 hover:text-slate-900"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-sm truncate">
              <span className="text-slate-400 hidden sm:inline">Support Operations</span>
              <span aria-hidden="true" className="text-slate-300 hidden sm:inline">
                /
              </span>
              <h1 className="font-semibold text-slate-900 truncate">{activeNavLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {isVoiceConnected ? (
              <button
                type="button"
                onClick={() => void stopVoiceSession()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors whitespace-nowrap shrink-0"
              >
                <PhoneOff className="h-3.5 w-3.5" />
                End Live Voice
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setActiveSection('console');
                  void startVoiceSession({
                    customerName: 'Darius Holloway',
                    company: 'Apex Freight Cloud',
                    customerEmail: 'dholloway@apexfreight.io',
                    slaTier: 'Enterprise',
                    platform: 'salesforce',
                  });
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
              >
                <PhoneCall className="h-3.5 w-3.5" />
                Start Live Voice
              </button>
            )}
          </div>
        </header>

        {/* Active View Viewport */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {activeSection === 'console' && (
            <LiveCallConsole
              isVoiceConnected={isVoiceConnected}
              isMicMuted={isMicMuted}
              isAgentSpeaking={isAgentSpeaking}
              audioAmplitude={audioAmplitude}
              voicePersona={voicePersona}
              onVoicePersonaChange={setVoicePersona}
              onStartVoice={startVoiceSession}
              onStopVoice={() => void stopVoiceSession()}
              onToggleMute={() => setIsMicMuted((m) => !m)}
              turns={turns}
              activeTicket={activeTicket}
              latestNlu={latestNlu}
              isProcessingTurn={isProcessingTurn}
              errorMessage={errorMessage}
              onSendTurn={handleSendTurn}
              onResetSession={handleResetSession}
              onSyncTicket={handleSyncTicket}
              onOpenTicketQueue={() => setActiveSection('tickets')}
            />
          )}

          {activeSection === 'tickets' && (
            <TicketQueueView
              tickets={tickets}
              onUpdateTicket={handleUpdateTicket}
              onSyncTicket={handleSyncTicket}
            />
          )}

          {activeSection === 'rules' && (
            <TriageRulesView rules={rules} onSaveRule={handleSaveRule} />
          )}

          {activeSection === 'connectors' && (
            <ConnectorsView
              connectors={connectors}
              onSaveConnector={handleSaveConnector}
            />
          )}
        </main>
      </div>
    </div>
  );
}
