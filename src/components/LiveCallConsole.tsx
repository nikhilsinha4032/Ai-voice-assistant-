import { useState, useRef, useEffect } from 'react';
import {
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  RefreshCw,
  Code2,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import type {
  CallerScenario,
  CrmPlatform,
  CrmTicket,
  NluAnalysis,
  TranscriptTurn,
  VoicePersona,
} from '../types/support';
import { CALLER_SCENARIOS } from '../lib/seedData';
import {
  buildSalesforceCasePayload,
  buildZendeskTicketPayload,
  calculateRollingMetrics,
} from '../lib/triage';
import { VoiceWaveform } from './VoiceWaveform';

interface LiveCallConsoleProps {
  isVoiceConnected: boolean;
  isMicMuted: boolean;
  isAgentSpeaking: boolean;
  audioAmplitude: number;
  voicePersona: VoicePersona;
  onVoicePersonaChange: (voice: VoicePersona) => void;
  onStartVoice: (context: {
    customerName: string;
    company: string;
    customerEmail: string;
    slaTier: 'Enterprise' | 'Growth' | 'Standard';
    platform: CrmPlatform;
  }) => void;
  onStopVoice: () => void;
  onToggleMute: () => void;
  turns: TranscriptTurn[];
  activeTicket: CrmTicket | null;
  latestNlu: NluAnalysis | null;
  isProcessingTurn: boolean;
  errorMessage: string | null;
  onSendTurn: (params: {
    utterance: string;
    customerName: string;
    company: string;
    customerEmail: string;
    slaTier: 'Enterprise' | 'Growth' | 'Standard';
    targetPlatform: CrmPlatform;
  }) => Promise<void>;
  onResetSession: () => void;
  onSyncTicket: (ticketId: string) => Promise<void>;
  onOpenTicketQueue: () => void;
}

function sentimentColorClass(sentiment: NluAnalysis['sentiment'] | undefined): string {
  if (sentiment === 'Negative') return 'text-red-600';
  if (sentiment === 'Mixed') return 'text-amber-600';
  if (sentiment === 'Positive') return 'text-emerald-600';
  return 'text-slate-700';
}

function priorityColorClass(priority: CrmTicket['priority']): string {
  if (priority === 'P1') return 'text-red-600';
  if (priority === 'P2') return 'text-amber-600';
  if (priority === 'P3') return 'text-blue-600';
  return 'text-slate-600';
}

export function LiveCallConsole({
  isVoiceConnected,
  isMicMuted,
  isAgentSpeaking,
  audioAmplitude,
  voicePersona,
  onVoicePersonaChange,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  turns,
  activeTicket,
  latestNlu,
  isProcessingTurn,
  errorMessage,
  onSendTurn,
  onResetSession,
  onSyncTicket,
  onOpenTicketQueue,
}: LiveCallConsoleProps) {
  const [customerName, setCustomerName] = useState('Darius Holloway');
  const [company, setCompany] = useState('Apex Freight Cloud');
  const [customerEmail, setCustomerEmail] = useState('dholloway@apexfreight.io');
  const [slaTier, setSlaTier] = useState<'Enterprise' | 'Growth' | 'Standard'>('Enterprise');
  const [targetPlatform, setTargetPlatform] = useState<CrmPlatform>('salesforce');
  const [draftUtterance, setDraftUtterance] = useState('');
  const [showPayload, setShowPayload] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (turns.length > 0 && transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop =
        transcriptContainerRef.current.scrollHeight;
    }
  }, [turns.length]);

  const metrics = calculateRollingMetrics(turns);
  const sentimentScore = latestNlu?.sentimentScore ?? metrics.latestSentimentScore;
  const sentimentPct = Math.round(((sentimentScore + 1) / 2) * 100);

  const handleSubmitDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draftUtterance.trim();
    if (!text || isProcessingTurn) return;
    setDraftUtterance('');
    await onSendTurn({
      utterance: text,
      customerName,
      company,
      customerEmail,
      slaTier,
      targetPlatform,
    });
  };

  const handleScenarioClick = async (scenario: CallerScenario) => {
    setCustomerName(scenario.customerName);
    setCompany(scenario.company);
    setCustomerEmail(scenario.customerEmail);
    setSlaTier(scenario.slaTier);
    setTargetPlatform(scenario.targetPlatform);
    await onSendTurn({
      utterance: scenario.utterance,
      customerName: scenario.customerName,
      company: scenario.company,
      customerEmail: scenario.customerEmail,
      slaTier: scenario.slaTier,
      targetPlatform: scenario.targetPlatform,
    });
  };

  const handleSyncClick = async () => {
    if (!activeTicket || isSyncing) return;
    setIsSyncing(true);
    try {
      await onSyncTicket(activeTicket.id);
    } finally {
      setIsSyncing(false);
    }
  };

  const crmPayload = activeTicket
    ? activeTicket.platform === 'salesforce'
      ? buildSalesforceCasePayload(activeTicket)
      : buildZendeskTicketPayload(activeTicket)
    : null;

  return (
    <div className="space-y-6">
      {/* Top KPI summary row across full width */}
      <div className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Avg Response Latency</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 font-mono tabular-nums">
            {metrics.avgLatencyMs > 0 ? `${metrics.avgLatencyMs} ms` : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            P95: {metrics.p95LatencyMs > 0 ? `${metrics.p95LatencyMs} ms` : 'Standby'}
          </p>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Live Caller Sentiment</p>
          <p
            className={`mt-1 text-2xl font-semibold tracking-tight font-mono tabular-nums ${sentimentColorClass(
              latestNlu?.sentiment
            )}`}
          >
            {latestNlu ? `${latestNlu.sentiment} (${sentimentScore.toFixed(2)})` : 'Neutral (0.00)'}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Delta: {metrics.sentimentDelta >= 0 ? `+${metrics.sentimentDelta}` : metrics.sentimentDelta}
          </p>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Detected Intent</p>
          <p className="mt-1 text-lg font-semibold tracking-tight text-slate-900 truncate font-mono">
            {latestNlu?.intent ?? 'awaiting_utterance'}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            Confidence: {latestNlu ? `${Math.round(latestNlu.confidence * 100)}%` : '—'}
          </p>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Active CRM Triage</p>
          <p
            className={`mt-1 text-2xl font-semibold tracking-tight font-mono tabular-nums ${
              activeTicket ? priorityColorClass(activeTicket.priority) : 'text-slate-900'
            }`}
          >
            {activeTicket ? `${activeTicket.externalId} · ${activeTicket.priority}` : 'No Ticket'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {activeTicket
              ? `${activeTicket.platform === 'salesforce' ? 'Salesforce' : 'Zendesk'} · ${
                  activeTicket.syncStatus
                }`
              : 'Auto-creates on first turn'}
          </p>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800"
        >
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-600" />
          <div className="flex-1">{errorMessage}</div>
        </div>
      )}

      {/* Main 2-column Voice & Telemetry Split */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Live Voice & Transcript Stream */}
        <section className="xl:col-span-7 bg-white border border-slate-200 rounded-lg flex flex-col">
          {/* Caller Context & Live Audio Bar */}
          <div className="p-5 border-b border-slate-200 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-slate-900">
                  Real-Time Voice & NLU Stream
                </h2>
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  Full-duplex 16kHz/24kHz PCM voice with live transcription & CRM tagging
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {!isVoiceConnected ? (
                  <button
                    type="button"
                    onClick={() =>
                      onStartVoice({
                        customerName,
                        company,
                        customerEmail,
                        slaTier,
                        platform: targetPlatform,
                      })
                    }
                    className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 transition-colors whitespace-nowrap shrink-0"
                  >
                    <PhoneCall className="h-3.5 w-3.5" />
                    Connect Live Voice
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={onToggleMute}
                      aria-label={isMicMuted ? 'Unmute microphone' : 'Mute microphone'}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                        isMicMuted
                          ? 'bg-amber-50 border-amber-300 text-amber-800'
                          : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {isMicMuted ? (
                        <MicOff className="h-3.5 w-3.5" />
                      ) : (
                        <Mic className="h-3.5 w-3.5 text-blue-600" />
                      )}
                      {isMicMuted ? 'Muted' : 'Mic Active'}
                    </button>
                    <button
                      type="button"
                      onClick={onStopVoice}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-red-600 rounded-md hover:bg-red-700 transition-colors whitespace-nowrap shrink-0"
                    >
                      <PhoneOff className="h-3.5 w-3.5" />
                      End Call
                    </button>
                  </>
                )}
                {turns.length > 0 && (
                  <button
                    type="button"
                    onClick={onResetSession}
                    className="px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-md hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    New Session
                  </button>
                )}
              </div>
            </div>

            {/* Waveform Canvas */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="flex items-center gap-2 font-medium text-slate-700">
                  {isVoiceConnected && (
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full bg-blue-600 animate-pulse"
                    />
                  )}
                  {isAgentSpeaking
                    ? 'Agent Speaking (24kHz PCM)'
                    : isVoiceConnected
                    ? 'Listening to Caller (16kHz PCM)'
                    : 'Audio Channel Standby'}
                </span>
                <span className="font-mono tabular-nums">
                  Voice: {voicePersona} · Target: {targetPlatform === 'salesforce' ? 'Salesforce' : 'Zendesk'}
                </span>
              </div>
              <VoiceWaveform
                isLive={isVoiceConnected && !isMicMuted}
                isAgentSpeaking={isAgentSpeaking}
                amplitude={audioAmplitude}
                sentimentScore={sentimentScore}
              />
            </div>

            {/* Compact Caller Context Bar */}
            <div className="grid grid-cols-2 sm:grid-cols-12 gap-3 pt-1">
              <div className="sm:col-span-3">
                <label htmlFor="caller-name" className="block text-xs font-medium text-slate-600 mb-1">
                  Caller Name
                </label>
                <input
                  id="caller-name"
                  type="text"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
                />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor="caller-company" className="block text-xs font-medium text-slate-600 mb-1">
                  Account
                </label>
                <input
                  id="caller-company"
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="caller-sla" className="block text-xs font-medium text-slate-600 mb-1">
                  SLA Tier
                </label>
                <select
                  id="caller-sla"
                  value={slaTier}
                  onChange={(e) =>
                    setSlaTier(e.target.value as 'Enterprise' | 'Growth' | 'Standard')
                  }
                  className="w-full px-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
                >
                  <option value="Enterprise">Enterprise</option>
                  <option value="Growth">Growth</option>
                  <option value="Standard">Standard</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="target-crm" className="block text-xs font-medium text-slate-600 mb-1">
                  Target CRM
                </label>
                <select
                  id="target-crm"
                  value={targetPlatform}
                  onChange={(e) => setTargetPlatform(e.target.value as CrmPlatform)}
                  className="w-full px-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
                >
                  <option value="salesforce">Salesforce</option>
                  <option value="zendesk">Zendesk</option>
                </select>
              </div>
              <div className="col-span-2 sm:col-span-2">
                <label htmlFor="voice-persona" className="block text-xs font-medium text-slate-600 mb-1">
                  Voice Model
                </label>
                <select
                  id="voice-persona"
                  value={voicePersona}
                  onChange={(e) => onVoicePersonaChange(e.target.value as VoicePersona)}
                  className="w-full px-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
                >
                  <option value="Zephyr">Zephyr</option>
                  <option value="Kore">Kore</option>
                  <option value="Fenrir">Fenrir</option>
                  <option value="Puck">Puck</option>
                </select>
              </div>
            </div>
          </div>

          {/* Instant Caller Scenarios */}
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-slate-500 mr-1">Scenarios:</span>
              {CALLER_SCENARIOS.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  disabled={isProcessingTurn}
                  onClick={() => handleScenarioClick(scenario)}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:border-blue-400 hover:text-blue-700 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  {scenario.title}
                </button>
              ))}
            </div>
          </div>

          {/* Live Transcript Timeline */}
          <div
            ref={transcriptContainerRef}
            data-testid="transcript-stream"
            className="p-5 min-h-[280px] max-h-[400px] overflow-y-auto divide-y divide-slate-100"
          >
            {turns.length === 0 ? (
              <div className="h-[260px] flex flex-col items-center justify-center text-center px-6">
                <p className="text-sm font-medium text-slate-900">
                  Ready for live voice or simulated caller turn
                </p>
                <p className="mt-1 text-xs text-slate-500 max-w-md">
                  Click &ldquo;Connect Live Voice&rdquo; to speak via microphone, choose a test scenario above, or type a caller utterance below to trigger real-time NLU, sentiment analysis, and CRM auto-tagging.
                </p>
              </div>
            ) : (
              turns.map((turn) => (
                <div key={turn.id} className="py-3.5 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between gap-4 text-xs">
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-semibold ${
                          turn.speaker === 'agent' ? 'text-blue-700' : 'text-slate-900'
                        }`}
                      >
                        {turn.speaker === 'agent' ? 'Meridian AI Agent' : customerName}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {turn.timestamp}
                      </span>
                      {turn.nlu && (
                        <>
                          <span aria-hidden="true" className="text-slate-300">
                            ·
                          </span>
                          <span className={`font-medium ${sentimentColorClass(turn.nlu.sentiment)}`}>
                            {turn.nlu.sentiment} ({turn.nlu.emotion})
                          </span>
                        </>
                      )}
                    </div>
                    {typeof turn.latencyMs === 'number' && (
                      <span className="font-mono tabular-nums text-slate-500">
                        {turn.latencyMs} ms
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-800">{turn.text}</p>
                  {turn.nlu && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 font-mono">
                      <span>intent:{turn.nlu.intent}</span>
                      {turn.nlu.urgencySignals.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-red-600">
                            signals: {turn.nlu.urgencySignals.join(', ')}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
            {isProcessingTurn && (
              <div className="py-3 text-xs text-blue-700 font-medium">
                Analyzing NLU, sentiment & auto-tagging CRM ticket...
              </div>
            )}
          </div>

          {/* Utterance Composer */}
          <form
            onSubmit={handleSubmitDraft}
            className="p-4 border-t border-slate-200 bg-slate-50 rounded-b-lg flex items-center gap-3"
          >
            <label htmlFor="caller-utterance-input" className="sr-only">
              Simulate caller speech or follow-up message
            </label>
            <input
              id="caller-utterance-input"
              type="text"
              value={draftUtterance}
              onChange={(e) => setDraftUtterance(e.target.value)}
              placeholder="Type a caller utterance to test low-latency NLU & CRM triage..."
              className="flex-1 px-3.5 py-2 text-sm bg-white border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
            />
            <button
              type="submit"
              disabled={isProcessingTurn || !draftUtterance.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              Send Turn
            </button>
          </form>
        </section>

        {/* Right: NLU Telemetry & Live CRM Auto-Tagger */}
        <aside className="xl:col-span-5 space-y-6">
          {/* NLU & Sentiment Inspection */}
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                Natural Language & Sentiment
              </h2>
              <span className="text-xs font-mono tabular-nums text-slate-500">
                {latestNlu ? `${Math.round(latestNlu.confidence * 100)}% conf` : 'Standby'}
              </span>
            </div>

            {/* Sentiment Valence Bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">Sentiment Valence</span>
                <span
                  className={`font-mono tabular-nums font-semibold ${sentimentColorClass(
                    latestNlu?.sentiment
                  )}`}
                >
                  {latestNlu
                    ? `${latestNlu.sentiment} · ${sentimentScore.toFixed(2)}`
                    : 'Neutral · 0.00'}
                </span>
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-sm overflow-hidden relative">
                <div
                  className={`h-full transition-all duration-200 ${
                    sentimentScore <= -0.3
                      ? 'bg-red-600'
                      : sentimentScore < -0.05
                      ? 'bg-amber-500'
                      : sentimentScore >= 0.3
                      ? 'bg-emerald-600'
                      : 'bg-slate-400'
                  }`}
                  style={{ width: `${Math.max(4, Math.min(100, sentimentPct))}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-400">
                <span>-1.00 Negative</span>
                <span>0.00 Neutral</span>
                <span>+1.00 Positive</span>
              </div>
            </div>

            {/* Entities & Urgency Signals */}
            <div className="pt-3 border-t border-slate-100 grid grid-cols-2 gap-4 text-xs">
              <div>
                <p className="font-medium text-slate-500 mb-1.5">Extracted Entities</p>
                {latestNlu && latestNlu.entities.length > 0 ? (
                  <ul className="space-y-1 font-mono text-slate-800">
                    {latestNlu.entities.map((ent, idx) => (
                      <li key={`${ent.type}-${idx}`} className="truncate">
                        <span className="text-slate-400">{ent.type}:</span> {ent.value}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-400">None detected yet</p>
                )}
              </div>
              <div>
                <p className="font-medium text-slate-500 mb-1.5">Urgency Signals</p>
                {latestNlu && latestNlu.urgencySignals.length > 0 ? (
                  <ul className="space-y-1 font-mono text-red-700">
                    {latestNlu.urgencySignals.map((sig, idx) => (
                      <li key={`${sig}-${idx}`} className="truncate">
                        {sig}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-400">No escalation triggers</p>
                )}
              </div>
            </div>
          </section>

          {/* Linked CRM Ticket & Auto-Tags */}
          <section className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  CRM Ticket Auto-Tagging
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Synchronized with Salesforce & Zendesk priority queues
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenTicketQueue}
                className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap shrink-0"
              >
                All Tickets
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {activeTicket ? (
              <div className="space-y-3.5 pt-2 border-t border-slate-100">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono tabular-nums">
                      <span className="font-semibold text-slate-900">
                        {activeTicket.externalId}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className="text-slate-600">
                        {activeTicket.platform === 'salesforce'
                          ? 'Salesforce Case'
                          : 'Zendesk Ticket'}
                      </span>
                      <span aria-hidden="true" className="text-slate-300">
                        ·
                      </span>
                      <span className={`font-semibold ${priorityColorClass(activeTicket.priority)}`}>
                        {activeTicket.priority} ({activeTicket.zendeskPriority})
                      </span>
                    </div>
                    <h3 className="mt-1 text-sm font-semibold text-slate-900">
                      {activeTicket.subject}
                    </h3>
                  </div>
                </div>

                <p className="text-xs leading-relaxed text-slate-600">{activeTicket.summary}</p>

                <div className="grid grid-cols-3 gap-2 py-2.5 border-y border-slate-100 text-xs">
                  <div>
                    <span className="block text-slate-400">SLA Target</span>
                    <span className="font-mono tabular-nums font-medium text-slate-900">
                      {activeTicket.slaMinutes} min
                    </span>
                  </div>
                  <div>
                    <span className="block text-slate-400">Case Status</span>
                    <span className="font-medium text-slate-900">{activeTicket.status}</span>
                  </div>
                  <div>
                    <span className="block text-slate-400">CRM Sync</span>
                    <span className="font-medium text-emerald-700">{activeTicket.syncStatus}</span>
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-medium text-slate-500 mb-1">
                    Auto-Applied Priority Tags
                  </span>
                  <p className="text-xs font-mono text-slate-700 leading-relaxed">
                    {activeTicket.tags.join(' · ')}
                  </p>
                </div>

                <div className="flex items-center justify-between gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowPayload((prev) => !prev)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    {showPayload ? 'Hide CRM Payload' : 'Inspect CRM Payload'}
                  </button>
                  <button
                    type="button"
                    onClick={handleSyncClick}
                    disabled={isSyncing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                    {isSyncing ? 'Syncing...' : 'Push to CRM'}
                  </button>
                </div>

                {showPayload && crmPayload && (
                  <pre className="p-3 bg-slate-900 text-slate-100 rounded-md text-[11px] font-mono overflow-x-auto max-h-56">
                    {JSON.stringify(crmPayload, null, 2)}
                  </pre>
                )}
              </div>
            ) : (
              <div className="py-6 border-t border-slate-100 text-xs text-slate-500">
                No active ticket for this call yet. Trigger a caller turn or live voice session to automatically classify priority and tag Salesforce or Zendesk.
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
