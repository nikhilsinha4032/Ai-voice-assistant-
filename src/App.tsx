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
  LogOut,
  CheckCircle2,
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
  resampleFloat32,
} from './utils/audio';
import {
  buildLanguageTransitionMessage,
  mergeTranscriptChunk,
  normalizeLanguageName,
} from './lib/language';
import { classifyMicrophoneError, mapLanguageToBcp47 } from './lib/voiceBridge';
import { estimateSpeechDurationMs } from './lib/hologramSpeech';
import { sanitizeDocId } from './lib/firestorePayload';
import {
  auth,
  onAuthStateChanged,
  signInWithGoogle,
  signOutGoogle,
  type User,
} from './firebase';
import {
  clearTurnsInCloud,
  ensureUserBootstrap,
  saveUserSessionPrefs,
  subscribeUserWorkspace,
  syncTicketInCloud,
  updateConnectorInCloud,
  updateRuleInCloud,
  updateTicketManualInCloud,
  upsertTicketInCloud,
  upsertTurnInCloud,
} from './lib/userStore';
import { LiveCallConsole } from './components/LiveCallConsole';
import { TicketQueueView } from './components/TicketQueueView';
import { TriageRulesView } from './components/TriageRulesView';
import { ConnectorsView } from './components/ConnectorsView';
import { SignUpGate, type CustomerIntakeData } from './components/SignUpGate';

const LOCAL_PROFILE_KEY = 'meridian_customer_profile_v1';

function readStoredCustomerProfile(): CustomerIntakeData | null {
  try {
    const raw = window.localStorage.getItem(LOCAL_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CustomerIntakeData>;
    if (
      typeof parsed.displayName === 'string' &&
      parsed.displayName.trim() &&
      typeof parsed.email === 'string' &&
      parsed.email.trim()
    ) {
      return {
        displayName: parsed.displayName.trim(),
        email: parsed.email.trim(),
        company:
          typeof parsed.company === 'string' && parsed.company.trim()
            ? parsed.company.trim()
            : 'Personal Account',
        preferredLanguage:
          typeof parsed.preferredLanguage === 'string' && parsed.preferredLanguage.trim()
            ? parsed.preferredLanguage.trim()
            : 'auto',
        targetPlatform: parsed.targetPlatform === 'zendesk' ? 'zendesk' : 'salesforce',
      };
    }
    return null;
  } catch {
    return null;
  }
}

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

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
      />
    </svg>
  );
}

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('console');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [localCustomerProfile, setLocalCustomerProfile] =
    useState<CustomerIntakeData | null>(() => readStoredCustomerProfile());
  const [cloudCompany, setCloudCompany] = useState<string | undefined>(undefined);
  const [cloudPlatform, setCloudPlatform] = useState<CrmPlatform | undefined>(undefined);

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
  const [selectedLanguage, setSelectedLanguage] = useState<string>(
    () => readStoredCustomerProfile()?.preferredLanguage || 'auto'
  );
  const [activeLanguage, setActiveLanguage] = useState<string | null>(() =>
    normalizeLanguageName(readStoredCustomerProfile()?.preferredLanguage)
  );
  const [switchPending, setSwitchPending] = useState(false);
  const [isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [voiceMode, setVoiceMode] = useState<'live' | 'bridge' | 'speaker' | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [isMicUnavailable, setIsMicUnavailable] = useState(false);
  const [isVoiceOutputEnabled, setIsVoiceOutputEnabled] = useState(true);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isReplyAnimating, setIsReplyAnimating] = useState(false);
  const [audioAmplitude, setAudioAmplitude] = useState(0);

  // Refs to prevent stale closures across audio/WebSocket/auth callbacks
  const isMicMutedRef = useRef(false);
  const isVoiceOutputEnabledRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const playbackRef = useRef<AudioPlaybackScheduler | null>(null);
  const lastLiveTurnIdRef = useRef<{ caller?: string; agent?: string }>({});
  const replyAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authUserRef = useRef<User | null>(null);
  const wasSignedInRef = useRef(false);
  const pendingIntakeRef = useRef<Partial<CustomerIntakeData> | null>(null);
  const turnsRef = useRef<TranscriptTurn[]>([]);
  const persistedTurnIdsRef = useRef<Set<string>>(new Set());
  const knownTicketIdsRef = useRef<Set<string>>(new Set());
  const pendingLiveFlushesRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    isMicMutedRef.current = isMicMuted;
  }, [isMicMuted]);

  useEffect(() => {
    isVoiceOutputEnabledRef.current = isVoiceOutputEnabled;
  }, [isVoiceOutputEnabled]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    authUserRef.current = authUser;
  }, [authUser]);

  // Real-time audio amplitude metering for 3D hologram & waveform while speaking
  useEffect(() => {
    if (!isAgentSpeaking) return;
    let timerId: number | null = null;
    const pollAmplitude = () => {
      const scheduler = playbackRef.current;
      if (scheduler && scheduler.isPlaying()) {
        const liveAmp = scheduler.getLiveAmplitude();
        if (liveAmp > 0.005) {
          setAudioAmplitude(liveAmp);
        }
      }
      timerId = window.setTimeout(pollAmplitude, 55);
    };
    timerId = window.setTimeout(pollAmplitude, 55);
    return () => {
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [isAgentSpeaking]);

  const ensurePlaybackScheduler = useCallback((): AudioPlaybackScheduler => {
    if (!playbackRef.current) {
      playbackRef.current = new AudioPlaybackScheduler();
    }
    playbackRef.current.ensureContext();
    return playbackRef.current;
  }, []);

  const speakWithBrowserFallback = useCallback((text: string, langHint?: string | null) => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }
    try {
      const synth = window.speechSynthesis;
      if (speechFallbackTimerRef.current) {
        clearTimeout(speechFallbackTimerRef.current);
        speechFallbackTimerRef.current = null;
      }
      const needsCancel = synth.speaking || synth.pending;
      if (needsCancel) {
        synth.cancel();
      }
      const launch = () => {
        if (!isVoiceOutputEnabledRef.current) return;
        const utterance = new SpeechSynthesisUtterance(text);
        const bcp47 = mapLanguageToBcp47(langHint);
        utterance.lang = bcp47;
        const voices = synth.getVoices();
        if (voices.length > 0) {
          const langPrefix = bcp47.split('-')[0].toLowerCase();
          const match =
            voices.find((v) => v.lang.toLowerCase() === bcp47.toLowerCase()) ||
            voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix)) ||
            voices.find((v) => v.default);
          if (match) utterance.voice = match;
        }
        utterance.onstart = () => setIsAgentSpeaking(true);
        utterance.onend = () => {
          setIsAgentSpeaking(false);
          setAudioAmplitude(0);
        };
        utterance.onerror = () => {
          setIsAgentSpeaking(false);
          setAudioAmplitude(0);
        };
        synth.resume();
        synth.speak(utterance);
      };
      if (needsCancel) {
        speechFallbackTimerRef.current = setTimeout(launch, 45);
      } else {
        launch();
      }
    } catch {
      setIsAgentSpeaking(false);
      setAudioAmplitude(0);
    }
  }, []);

  const handleToggleVoiceOutput = useCallback(() => {
    setIsVoiceOutputEnabled((prev) => {
      const next = !prev;
      isVoiceOutputEnabledRef.current = next;
      if (next) {
        ensurePlaybackScheduler();
      } else {
        playbackRef.current?.interrupt();
        if (speechFallbackTimerRef.current) {
          clearTimeout(speechFallbackTimerRef.current);
          speechFallbackTimerRef.current = null;
        }
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
        setIsAgentSpeaking(false);
        setAudioAmplitude(0);
      }
      return next;
    });
  }, [ensurePlaybackScheduler]);

  // Fetch demo backend CRM state (used when signed out)
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

  const persistTurnSmart = useCallback((uid: string, turn: TranscriptTurn) => {
    const safeId = sanitizeDocId(turn.id, 'turn');
    const isUpdate = persistedTurnIdsRef.current.has(safeId);
    persistedTurnIdsRef.current.add(safeId);
    void upsertTurnInCloud(uid, { ...turn, id: safeId }, isUpdate).catch((err) => {
      persistedTurnIdsRef.current.delete(safeId);
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save transcript turn.');
    });
  }, []);

  const persistTicketSmart = useCallback((uid: string, ticket: CrmTicket) => {
    const safeId = sanitizeDocId(ticket.id, 'tkt');
    const existed = knownTicketIdsRef.current.has(safeId);
    void upsertTicketInCloud(uid, { ...ticket, id: safeId }, existed)
      .then(() => {
        knownTicketIdsRef.current.add(safeId);
      })
      .catch((err) => {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to save CRM ticket.');
      });
  }, []);

  const persistSessionPrefsSafe = useCallback(
    (
      uid: string,
      prefs: {
        preferredLanguage?: string;
        activeTicketId?: string | null;
        activeLanguage?: string | null;
      }
    ) => {
      void saveUserSessionPrefs(uid, prefs).catch((err) => {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to save session preferences.'
        );
      });
    },
    []
  );

  const scheduleLiveTurnFlush = useCallback(
    (uid: string, turnId: string) => {
      const existingTimer = pendingLiveFlushesRef.current.get(turnId);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        pendingLiveFlushesRef.current.delete(turnId);
        const target = turnsRef.current.find((t) => t.id === turnId);
        if (target && authUserRef.current?.uid === uid) {
          persistTurnSmart(uid, target);
        }
      }, 450);
      pendingLiveFlushesRef.current.set(turnId, timer);
    },
    [persistTurnSmart]
  );

  const flushAllPendingLiveTurns = useCallback(() => {
    const uid = authUserRef.current?.uid;
    for (const [turnId, timer] of pendingLiveFlushesRef.current.entries()) {
      clearTimeout(timer);
      pendingLiveFlushesRef.current.delete(turnId);
      if (uid && authUserRef.current?.emailVerified) {
        const target = turnsRef.current.find((t) => t.id === turnId);
        if (target) persistTurnSmart(uid, target);
      }
    }
  }, [persistTurnSmart]);

  // Firebase Authentication & Firestore Workspace Hydration
  useEffect(() => {
    let unsubWorkspace: (() => void) | null = null;
    let cancelled = false;

    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (unsubWorkspace) {
        unsubWorkspace();
        unsubWorkspace = null;
      }

      if (!user) {
        setAuthUser(null);
        authUserRef.current = null;
        persistedTurnIdsRef.current.clear();
        knownTicketIdsRef.current.clear();
        if (wasSignedInRef.current) {
          wasSignedInRef.current = false;
          setTurns([]);
          setActiveTicketId(null);
          setLatestNlu(null);
          setActiveLanguage(null);
          setSelectedLanguage('auto');
          setSwitchPending(false);
        }
        setAuthReady(true);
        void fetchCrmState();
        return;
      }

      if (!user.emailVerified) {
        setErrorMessage('Please verify your Google account email to sync your data.');
        setAuthUser(user);
        setAuthReady(true);
        return;
      }

      wasSignedInRef.current = true;
      setAuthUser(user);
      authUserRef.current = user;
      setErrorMessage(null);

      try {
        const draftOverride = pendingIntakeRef.current || localCustomerProfile;
        pendingIntakeRef.current = null;
        if (draftOverride?.targetPlatform) {
          setCloudPlatform(draftOverride.targetPlatform);
        }
        const profile = await ensureUserBootstrap(
          user,
          {
            tickets: INITIAL_TICKETS,
            rules: DEFAULT_TRIAGE_RULES,
            connectors: INITIAL_CONNECTORS,
          },
          draftOverride
            ? {
                displayName: draftOverride.displayName,
                company: draftOverride.company,
                preferredLanguage: draftOverride.preferredLanguage,
              }
            : null
        );
        if (cancelled) return;

        if (profile.company) {
          setCloudCompany(profile.company);
        }
        if (profile.preferredLanguage) {
          setSelectedLanguage(profile.preferredLanguage);
        }
        if (profile.activeLanguage) {
          setActiveLanguage(profile.activeLanguage);
        }
        if (profile.activeTicketId) {
          setActiveTicketId(profile.activeTicketId);
        }

        unsubWorkspace = subscribeUserWorkspace(user.uid, {
          onProfile: (p) => {
            if (p.company) setCloudCompany(p.company);
            if (p.preferredLanguage) setSelectedLanguage(p.preferredLanguage);
            if (p.activeLanguage !== undefined) {
              setActiveLanguage(p.activeLanguage || null);
            }
            if (p.activeTicketId !== undefined) {
              setActiveTicketId(p.activeTicketId || null);
            }
          },
          onTickets: (loadedTickets) => {
            knownTicketIdsRef.current = new Set(loadedTickets.map((t) => t.id));
            setTickets(loadedTickets);
          },
          onTurns: (loadedTurns) => {
            persistedTurnIdsRef.current = new Set(loadedTurns.map((t) => t.id));
            setTurns(loadedTurns);
            const lastNluTurn = [...loadedTurns].reverse().find((t) => Boolean(t.nlu));
            if (lastNluTurn?.nlu) {
              setLatestNlu(lastNluTurn.nlu);
            }
          },
          onRules: (loadedRules) => {
            if (loadedRules.length > 0) setRules(loadedRules);
          },
          onConnectors: (loadedConnectors) => {
            if (loadedConnectors.length > 0) setConnectors(loadedConnectors);
          },
          onError: (err) => {
            setErrorMessage(`Cloud sync error: ${err.message}`);
          },
        });
      } catch (err: unknown) {
        if (!cancelled) {
          setErrorMessage(
            err instanceof Error ? err.message : 'Unable to initialize cloud workspace.'
          );
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    });

    return () => {
      cancelled = true;
      unsubAuth();
      if (unsubWorkspace) unsubWorkspace();
    };
  }, [fetchCrmState]);

  const stopVoiceSession = useCallback(async () => {
    flushAllPendingLiveTurns();
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
    if (speechFallbackTimerRef.current) {
      clearTimeout(speechFallbackTimerRef.current);
      speechFallbackTimerRef.current = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    if (replyAnimTimerRef.current) {
      clearTimeout(replyAnimTimerRef.current);
      replyAnimTimerRef.current = null;
    }
    setIsVoiceConnected(false);
    setVoiceMode(null);
    setVoiceNotice(null);
    setIsMicUnavailable(false);
    setIsAgentSpeaking(false);
    setIsReplyAnimating(false);
    setAudioAmplitude(0);
  }, [flushAllPendingLiveTurns]);

  useEffect(() => {
    return () => {
      if (replyAnimTimerRef.current) {
        clearTimeout(replyAnimTimerRef.current);
      }
      if (speechFallbackTimerRef.current) {
        clearTimeout(speechFallbackTimerRef.current);
      }
      void stopVoiceSession();
    };
  }, [stopVoiceSession]);

  const handleCompleteSignUp = (data: CustomerIntakeData) => {
    setErrorMessage(null);
    setLocalCustomerProfile(data);
    try {
      window.localStorage.setItem(LOCAL_PROFILE_KEY, JSON.stringify(data));
    } catch {
      // Ignore storage quota issues
    }
    setSelectedLanguage(data.preferredLanguage);
    setActiveLanguage(normalizeLanguageName(data.preferredLanguage));
    setActiveSection('console');
  };

  const handleGoogleSignIn = async (draftProfile?: Partial<CustomerIntakeData>) => {
    setErrorMessage(null);
    if (draftProfile) {
      pendingIntakeRef.current = draftProfile;
    } else if (localCustomerProfile) {
      pendingIntakeRef.current = localCustomerProfile;
    }
    setIsSigningIn(true);
    try {
      await signInWithGoogle();
      setActiveSection('console');
    } catch (err: unknown) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: string }).code)
          : '';
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request') {
        setErrorMessage(err instanceof Error ? err.message : 'Google sign-in failed.');
      }
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await stopVoiceSession();
    try {
      window.localStorage.removeItem(LOCAL_PROFILE_KEY);
    } catch {
      // Ignore storage errors
    }
    setLocalCustomerProfile(null);
    setCloudCompany(undefined);
    setCloudPlatform(undefined);
    setTurns([]);
    setActiveTicketId(null);
    setLatestNlu(null);
    setActiveLanguage(null);
    setSelectedLanguage('auto');
    setSwitchPending(false);
    setErrorMessage(null);
    if (auth.currentUser) {
      await signOutGoogle();
    }
  };

  const isStartingVoiceRef = useRef(false);

  const startVoiceSession = async (context: {
    customerName: string;
    company: string;
    customerEmail: string;
    slaTier: 'Enterprise' | 'Growth' | 'Standard';
    platform: CrmPlatform;
    language?: string;
  }) => {
    if (isStartingVoiceRef.current) return;
    isStartingVoiceRef.current = true;
    setErrorMessage(null);
    if (isVoiceConnected || wsRef.current || mediaStreamRef.current) {
      await stopVoiceSession();
    }

    try {
      ensurePlaybackScheduler();

      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        const classified = classifyMicrophoneError(new Error('mediaDevices unavailable'));
        setIsMicUnavailable(true);
        setIsMicMuted(true);
        setVoiceMode('speaker');
        setVoiceNotice(classified.notice);
        setIsVoiceConnected(true);
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (micErr: unknown) {
        const classified = classifyMicrophoneError(micErr);
        setIsMicUnavailable(true);
        setIsMicMuted(true);
        setVoiceMode('speaker');
        setVoiceNotice(classified.notice);
        setIsVoiceConnected(true);
        return;
      }

      setIsMicUnavailable(false);
      setIsMicMuted(false);
      mediaStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      if (inputCtx.state === 'suspended') {
        void inputCtx.resume();
      }
      inputAudioCtxRef.current = inputCtx;

      const effectiveLanguage =
        context.language || activeLanguage || (selectedLanguage === 'auto' ? 'auto' : selectedLanguage);

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const qs = new URLSearchParams({
        voice: voicePersona,
        platform: context.platform,
        customerName: context.customerName,
        company: context.company,
        customerEmail: context.customerEmail,
        slaTier: context.slaTier,
        language: effectiveLanguage,
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
          const rawSamples = event.inputBuffer.getChannelData(0);
          const samples16k = resampleFloat32(rawSamples, inputCtx.sampleRate, 16000);
          const rms = computeRmsAmplitude(samples16k);
          setAudioAmplitude(rms);
          const base64Audio = float32ToInt16Base64(samples16k);
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
          activeLanguage?: string | null;
          previousLanguage?: string | null;
          transitionMessage?: string;
          mode?: 'live' | 'bridge';
          notice?: string;
          language?: string | null;
        };

        const currentUser = authUserRef.current;
        const canPersistCloud = Boolean(currentUser?.uid && currentUser.emailVerified);
        const uid = currentUser?.uid ?? '';

        if (msg.type === 'ready') {
          if (msg.activeLanguage) {
            setActiveLanguage(msg.activeLanguage);
          }
          setVoiceMode(msg.mode === 'bridge' ? 'bridge' : 'live');
          setVoiceNotice(msg.notice ?? null);
          return;
        }

        if (msg.type === 'language_changed') {
          if (msg.activeLanguage) {
            setActiveLanguage(msg.activeLanguage);
            setSwitchPending(false);
          }
          if (msg.ticket) {
            setTickets((prev) => {
              const exists = prev.some((t) => t.id === msg.ticket!.id);
              return exists
                ? prev.map((t) => (t.id === msg.ticket!.id ? msg.ticket! : t))
                : [msg.ticket!, ...prev];
            });
            if (canPersistCloud) {
              persistTicketSmart(uid, msg.ticket);
            }
          }
          const transitionText =
            msg.transitionMessage ||
            buildLanguageTransitionMessage(
              msg.previousLanguage ?? null,
              msg.activeLanguage || 'English'
            );
          lastLiveTurnIdRef.current.caller = undefined;
          lastLiveTurnIdRef.current.agent = undefined;
          const systemTurn: TranscriptTurn = {
            id: `turn-${Date.now()}-lang-${Math.random().toString(36).slice(2, 6)}`,
            speaker: 'system',
            text: transitionText,
            timestamp: formatClockTime(),
            channel: 'voice',
            language: msg.activeLanguage ?? undefined,
            previousLanguage: msg.previousLanguage ?? undefined,
          };
          setTurns((prev) => [...prev, systemTurn]);
          if (canPersistCloud) {
            persistTurnSmart(uid, systemTurn);
            if (msg.activeLanguage) {
              persistSessionPrefsSafe(uid, { activeLanguage: msg.activeLanguage });
            }
          }
          return;
        }

        if (msg.type === 'language_updated') {
          if (msg.activeLanguage) {
            setActiveLanguage(msg.activeLanguage);
            setSwitchPending(false);
            if (canPersistCloud) {
              persistSessionPrefsSafe(uid, { activeLanguage: msg.activeLanguage });
            }
          }
          if (msg.ticket) {
            setTickets((prev) => {
              const exists = prev.some((t) => t.id === msg.ticket!.id);
              return exists
                ? prev.map((t) => (t.id === msg.ticket!.id ? msg.ticket! : t))
                : [msg.ticket!, ...prev];
            });
            if (canPersistCloud) {
              persistTicketSmart(uid, msg.ticket);
            }
          }
          return;
        }

        if (msg.type === 'error') {
          setErrorMessage(msg.error || 'Voice stream encountered an error.');
          void stopVoiceSession();
          return;
        }

        if (msg.type === 'closed') {
          setVoiceNotice('Live voice stream ended. Click Connect Live Voice to reconnect.');
          void stopVoiceSession();
          return;
        }

        if (msg.type === 'input_transcript' && msg.text) {
          lastLiveTurnIdRef.current.agent = undefined;
          const existingId = lastLiveTurnIdRef.current.caller;
          const timestamp = formatClockTime();
          if (existingId) {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === existingId
                  ? { ...t, text: mergeTranscriptChunk(t.text, msg.text ?? '') }
                  : t
              )
            );
            if (canPersistCloud) scheduleLiveTurnFlush(uid, existingId);
          } else {
            const newId = `turn-${Date.now()}-caller`;
            lastLiveTurnIdRef.current.caller = newId;
            const callerTurn: TranscriptTurn = {
              id: newId,
              speaker: 'caller',
              text: (msg.text ?? '').trimStart(),
              timestamp,
              channel: 'voice',
            };
            setTurns((prev) => [...prev, callerTurn]);
            if (canPersistCloud) scheduleLiveTurnFlush(uid, newId);
          }
        }

        if (msg.type === 'output_transcript' && msg.text) {
          lastLiveTurnIdRef.current.caller = undefined;
          const existingId = lastLiveTurnIdRef.current.agent;
          const timestamp = formatClockTime();
          if (existingId) {
            setTurns((prev) =>
              prev.map((t) =>
                t.id === existingId
                  ? {
                      ...t,
                      text: mergeTranscriptChunk(t.text, msg.text ?? ''),
                      ...(typeof msg.latencyMs === 'number' ? { latencyMs: msg.latencyMs } : {}),
                    }
                  : t
              )
            );
            if (canPersistCloud) scheduleLiveTurnFlush(uid, existingId);
          } else {
            const newId = `turn-${Date.now()}-agent`;
            lastLiveTurnIdRef.current.agent = newId;
            const agentTurn: TranscriptTurn = {
              id: newId,
              speaker: 'agent',
              text: (msg.text ?? '').trimStart(),
              timestamp,
              channel: 'voice',
              ...(typeof msg.latencyMs === 'number' ? { latencyMs: msg.latencyMs } : {}),
            };
            setTurns((prev) => [...prev, agentTurn]);
            if (canPersistCloud) scheduleLiveTurnFlush(uid, newId);
          }
        }

        if (msg.type === 'speak_fallback' && msg.text) {
          if (isVoiceOutputEnabledRef.current) {
            speakWithBrowserFallback(msg.text, msg.language ?? activeLanguage);
          }
          return;
        }

        if (msg.type === 'audio' && msg.data && playbackRef.current) {
          if (isVoiceOutputEnabledRef.current) {
            setIsAgentSpeaking(true);
            const amp = playbackRef.current.enqueuePcm24k(msg.data, () => {
              setIsAgentSpeaking(false);
              setAudioAmplitude(0);
            });
            setAudioAmplitude(amp);
          }

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
              if (canPersistCloud) scheduleLiveTurnFlush(uid, agentTurnId);
            }
          }
        }

        if (msg.type === 'interrupted') {
          playbackRef.current?.interrupt();
          if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
          }
          setIsAgentSpeaking(false);
        }

        if (msg.type === 'crm_ticket_updated' && msg.ticket) {
          if (msg.nlu) {
            setLatestNlu(msg.nlu);
            if (msg.nlu.language) {
              setActiveLanguage(msg.nlu.language);
            }
          }
          setActiveTicketId(msg.ticket.id);
          setTickets((prev) => {
            const exists = prev.some((t) => t.id === msg.ticket!.id);
            return exists
              ? prev.map((t) => (t.id === msg.ticket!.id ? msg.ticket! : t))
              : [msg.ticket!, ...prev];
          });
          if (canPersistCloud) {
            flushAllPendingLiveTurns();
            persistTicketSmart(uid, msg.ticket);
            persistSessionPrefsSafe(uid, {
              activeTicketId: msg.ticket.id,
              activeLanguage: msg.nlu?.language ?? activeLanguage ?? '',
            });
          }
        }
      };

      ws.onerror = () => {
        setErrorMessage(
          'Live voice WebSocket connection failed. You can still test low-latency NLU & CRM tagging using scenarios or text turns below.'
        );
        void stopVoiceSession();
      };
    } catch (err: unknown) {
      const classified = classifyMicrophoneError(err);
      setIsMicUnavailable(true);
      setIsMicMuted(true);
      setVoiceMode('speaker');
      setVoiceNotice(classified.notice);
      setIsVoiceConnected(true);
    } finally {
      isStartingVoiceRef.current = false;
    }
  };

  const handleLanguageSelectChange = (nextLang: string) => {
    const previous = activeLanguage;
    setSelectedLanguage(nextLang);
    const normalized = normalizeLanguageName(nextLang);
    setActiveLanguage(normalized);
    setSwitchPending(false);

    const canPersistCloud = Boolean(authUser?.uid && authUser.emailVerified);
    if (canPersistCloud && authUser) {
      persistSessionPrefsSafe(authUser.uid, {
        preferredLanguage: nextLang,
        activeLanguage: normalized ?? '',
      });
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'set_language', language: nextLang }));
    } else if (normalized && previous && normalized !== previous && turns.length > 0) {
      const transitionTurn: TranscriptTurn = {
        id: `turn-${Date.now()}-lang-${Math.random().toString(36).slice(2, 6)}`,
        speaker: 'system',
        text: buildLanguageTransitionMessage(previous, normalized),
        timestamp: formatClockTime(),
        channel: 'text',
        language: normalized,
        previousLanguage: previous,
      };
      setTurns((prev) => [...prev, transitionTurn]);
      if (canPersistCloud && authUser) {
        persistTurnSmart(authUser.uid, transitionTurn);
      }
    }
  };

  const handleSendTurn = async (params: {
    utterance: string;
    customerName: string;
    company: string;
    customerEmail: string;
    slaTier: 'Enterprise' | 'Growth' | 'Standard';
    targetPlatform: CrmPlatform;
    resetLock?: boolean;
  }) => {
    setErrorMessage(null);
    if (replyAnimTimerRef.current) {
      clearTimeout(replyAnimTimerRef.current);
      replyAnimTimerRef.current = null;
    }
    setIsReplyAnimating(false);
    if (isVoiceOutputEnabledRef.current) {
      ensurePlaybackScheduler().interrupt();
    }
    setIsProcessingTurn(true);

    const canPersistCloud = Boolean(authUser?.uid && authUser.emailVerified);
    const uid = authUser?.uid ?? '';
    const baseMs = Date.now();

    if (params.resetLock && canPersistCloud && turns.length > 0) {
      const oldIds = turns.map((t) => t.id);
      persistedTurnIdsRef.current.clear();
      void clearTurnsInCloud(uid, oldIds).catch((err) => {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to clear cloud turns.');
      });
    }

    const callerTurn: TranscriptTurn = {
      id: `turn-${baseMs}-0-c`,
      speaker: 'caller',
      text: params.utterance,
      timestamp: formatClockTime(),
      channel: 'text',
    };

    const baseTurns = params.resetLock ? [] : turns;
    const nextHistory = [...baseTurns, callerTurn]
      .filter((t) => t.speaker !== 'system')
      .map((t) => ({
        speaker: t.speaker,
        text: t.text,
      }));

    setTurns((prev) => (params.resetLock ? [callerTurn] : [...prev, callerTurn]));

    const lockedLangForTurn = params.resetLock
      ? null
      : activeLanguage || normalizeLanguageName(selectedLanguage);

    const currentActiveTicket =
      !params.resetLock && activeTicketId
        ? tickets.find((t) => t.id === activeTicketId) ?? null
        : null;

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
          activeTicketId: params.resetLock ? undefined : activeTicketId,
          existingTicket: currentActiveTicket,
          rulesOverride: canPersistCloud ? rules : undefined,
          lockedLanguage: lockedLangForTurn,
          switchPending: params.resetLock ? false : switchPending,
        }),
      });

      const payload = (await res.json()) as {
        reply?: string;
        latencyMs?: number;
        nlu?: NluAnalysis;
        ticket?: CrmTicket;
        error?: string;
        activeLanguage?: string;
        languageSwitched?: boolean;
        switchPending?: boolean;
        languageChangedEvent?: {
          type: 'language_changed';
          previousLanguage?: string | null;
          activeLanguage: string;
          transitionMessage: string;
        };
      };

      if (!res.ok) {
        throw new Error(payload.error || 'Failed to process support turn.');
      }

      if (payload.activeLanguage) {
        setActiveLanguage(payload.activeLanguage);
      }
      setSwitchPending(Boolean(payload.switchPending));

      if (payload.nlu) {
        setLatestNlu(payload.nlu);
      }

      const enrichedCallerTurn: TranscriptTurn = {
        ...callerTurn,
        nlu: payload.nlu,
        language: payload.activeLanguage,
      };

      const transitionTurn: TranscriptTurn | null = payload.languageChangedEvent
        ? {
            id: `turn-${baseMs + 1}-1-lang`,
            speaker: 'system',
            text: payload.languageChangedEvent.transitionMessage,
            timestamp: formatClockTime(),
            channel: 'text',
            language: payload.languageChangedEvent.activeLanguage,
            previousLanguage: payload.languageChangedEvent.previousLanguage ?? undefined,
          }
        : null;

      const agentTurn: TranscriptTurn = {
        id: `turn-${baseMs + 2}-2-a`,
        speaker: 'agent',
        text: payload.reply || '',
        timestamp: formatClockTime(),
        latencyMs: payload.latencyMs,
        channel: 'text',
        language: payload.activeLanguage,
      };

      setTurns((prev) =>
        prev
          .map((t) => (t.id === callerTurn.id ? enrichedCallerTurn : t))
          .concat(transitionTurn ? [transitionTurn, agentTurn] : [agentTurn])
      );

      if (payload.reply && payload.reply.trim()) {
        const replyText = payload.reply.trim();
        const animDuration = estimateSpeechDurationMs(replyText);
        if (replyAnimTimerRef.current) {
          clearTimeout(replyAnimTimerRef.current);
        }
        setIsReplyAnimating(true);
        replyAnimTimerRef.current = setTimeout(() => {
          replyAnimTimerRef.current = null;
          setIsReplyAnimating(false);
        }, animDuration);

        if (isVoiceOutputEnabledRef.current) {
          const scheduler = ensurePlaybackScheduler();
          void (async () => {
            try {
              const ttsRes = await fetch('/api/voice/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: replyText, voiceName: voicePersona }),
              });
              const ttsData = ttsRes.ok
                ? ((await ttsRes.json()) as {
                    audioChunks?: string[];
                    wavBase64?: string;
                    fallback?: boolean;
                  })
                : { audioChunks: [], fallback: true };

              if (!isVoiceOutputEnabledRef.current) return;

              if (ttsData.audioChunks && ttsData.audioChunks.length > 0) {
                setIsAgentSpeaking(true);
                const amp = await scheduler.enqueuePcm24kBatch(ttsData.audioChunks, () => {
                  setIsAgentSpeaking(false);
                  setAudioAmplitude(0);
                });
                setAudioAmplitude(amp);
              } else if (ttsData.wavBase64) {
                setIsAgentSpeaking(true);
                const played = await scheduler.playWavBase64(ttsData.wavBase64, () => {
                  setIsAgentSpeaking(false);
                  setAudioAmplitude(0);
                });
                if (!played) {
                  speakWithBrowserFallback(replyText, payload.activeLanguage ?? activeLanguage);
                }
              } else {
                speakWithBrowserFallback(replyText, payload.activeLanguage ?? activeLanguage);
              }
            } catch {
              speakWithBrowserFallback(replyText, payload.activeLanguage ?? activeLanguage);
            }
          })();
        }
      }

      if (canPersistCloud) {
        persistTurnSmart(uid, enrichedCallerTurn);
        if (transitionTurn) persistTurnSmart(uid, transitionTurn);
        persistTurnSmart(uid, agentTurn);
      }

      if (payload.ticket) {
        const updatedTicket = payload.ticket;
        setActiveTicketId(updatedTicket.id);
        setTickets((prev) => {
          const exists = prev.some((t) => t.id === updatedTicket.id);
          return exists
            ? prev.map((t) => (t.id === updatedTicket.id ? updatedTicket : t))
            : [updatedTicket, ...prev];
        });
        if (canPersistCloud) {
          persistTicketSmart(uid, updatedTicket);
          persistSessionPrefsSafe(uid, {
            activeTicketId: updatedTicket.id,
            activeLanguage: payload.activeLanguage ?? activeLanguage ?? '',
          });
        }
      } else if (canPersistCloud && payload.activeLanguage) {
        persistSessionPrefsSafe(uid, { activeLanguage: payload.activeLanguage });
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
    const previousTurns = turns;
    if (replyAnimTimerRef.current) {
      clearTimeout(replyAnimTimerRef.current);
      replyAnimTimerRef.current = null;
    }
    setIsReplyAnimating(false);
    setTurns([]);
    setActiveTicketId(null);
    setLatestNlu(null);
    setErrorMessage(null);
    setSwitchPending(false);
    const nextLang = normalizeLanguageName(selectedLanguage);
    setActiveLanguage(nextLang);

    if (authUser?.uid && authUser.emailVerified) {
      persistedTurnIdsRef.current.clear();
      void clearTurnsInCloud(
        authUser.uid,
        previousTurns.map((t) => t.id)
      ).catch((err) => {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to clear cloud turns.');
      });
      persistSessionPrefsSafe(authUser.uid, {
        activeTicketId: '',
        activeLanguage: nextLang ?? '',
      });
    }
  };

  const handleUpdateTicket = async (
    id: string,
    patch: Partial<Pick<CrmTicket, 'status' | 'priority' | 'tags'>>
  ) => {
    const zendeskPriority =
      patch.priority === 'P1'
        ? 'urgent'
        : patch.priority === 'P2'
        ? 'high'
        : patch.priority === 'P3'
        ? 'normal'
        : patch.priority === 'P4'
        ? 'low'
        : undefined;

    if (authUser?.uid && authUser.emailVerified) {
      setTickets((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                ...patch,
                ...(zendeskPriority ? { zendeskPriority } : {}),
              }
            : t
        )
      );
      try {
        await updateTicketManualInCloud(authUser.uid, id, {
          ...patch,
          ...(zendeskPriority ? { zendeskPriority } : {}),
        });
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to update ticket.');
      }
      void fetch(`/api/crm/tickets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => undefined);
      return;
    }

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
    const targetTicket = tickets.find((t) => t.id === id);
    if (authUser?.uid && authUser.emailVerified && targetTicket) {
      const nowIso = new Date().toISOString();
      const targetConnector = connectors.find((c) => c.platform === targetTicket.platform);
      const nextCount = targetConnector ? targetConnector.ticketsSyncedCount + 1 : undefined;

      setTickets((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, syncStatus: 'Synced', lastSyncedAt: nowIso } : t
        )
      );
      if (targetConnector && typeof nextCount === 'number') {
        setConnectors((prev) =>
          prev.map((c) =>
            c.platform === targetTicket.platform
              ? { ...c, lastSyncAt: nowIso, ticketsSyncedCount: nextCount }
              : c
          )
        );
      }
      try {
        await syncTicketInCloud(
          authUser.uid,
          id,
          nowIso,
          targetTicket.platform,
          nextCount
        );
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to sync ticket.');
      }
      void fetch(`/api/crm/tickets/${id}/sync`, { method: 'POST' }).catch(() => undefined);
      return;
    }

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
    if (authUser?.uid && authUser.emailVerified) {
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      try {
        await updateRuleInCloud(authUser.uid, id, patch);
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to save rule.');
      }
      void fetch(`/api/crm/rules/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => undefined);
      return;
    }

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
    if (authUser?.uid && authUser.emailVerified) {
      setConnectors((prev) =>
        prev.map((c) => (c.platform === platform ? { ...c, ...patch } : c))
      );
      try {
        await updateConnectorInCloud(authUser.uid, platform, patch);
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to save connector.');
      }
      void fetch(`/api/crm/connectors/${platform}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => undefined);
      return;
    }

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

  const isCloudSynced = Boolean(authUser && authUser.emailVerified);
  const signedInProfile =
    isCloudSynced && authUser
      ? {
          displayName:
            authUser.displayName ||
            localCustomerProfile?.displayName ||
            authUser.email?.split('@')[0] ||
            'Customer',
          email: authUser.email || localCustomerProfile?.email || '',
          company: cloudCompany || localCustomerProfile?.company || 'Personal Account',
          targetPlatform: cloudPlatform || localCustomerProfile?.targetPlatform || 'salesforce',
        }
      : localCustomerProfile
      ? {
          displayName: localCustomerProfile.displayName,
          email: localCustomerProfile.email,
          company: localCustomerProfile.company,
          targetPlatform: localCustomerProfile.targetPlatform,
        }
      : null;

  if (!signedInProfile) {
    return (
      <SignUpGate
        onCompleteSignUp={handleCompleteSignUp}
        onGoogleSignIn={handleGoogleSignIn}
        isSigningIn={isSigningIn}
        authReady={authReady}
        errorMessage={errorMessage}
      />
    );
  }

  return (
    <div className="min-h-screen flex bg-[#f4f6fa] text-slate-900">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden md:flex md:w-[256px] md:shrink-0 md:flex-col md:sticky md:top-0 md:h-screen bg-slate-950 text-slate-100 border-r border-slate-900">
        <div className="h-16 px-5 flex items-center gap-2.5 border-b border-slate-800/80">
          <div className="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
            <AudioLines className="h-4 w-4 text-white" />
          </div>
          <span className="text-base font-semibold tracking-tight text-white whitespace-nowrap">
            Meridian Voice
          </span>
        </div>

        <nav aria-label="Workspace sections" className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-slate-800/90 text-white'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 ${active ? 'text-blue-400' : 'text-slate-500'}`}
                  />
                  {item.label}
                </span>
                {item.id === 'tickets' && (
                  <span
                    className={`text-xs font-mono tabular-nums ${
                      active ? 'text-blue-300' : 'text-slate-500'
                    }`}
                  >
                    {tickets.length}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/80 space-y-4 text-xs text-slate-400">
          <div className="space-y-2 pb-4 border-b border-slate-800/80">
            <div className="font-medium text-slate-300">Customer Account</div>
            <div className="space-y-2">
              <div className="flex items-center gap-2.5">
                {authUser?.photoURL ? (
                  <img
                    src={authUser.photoURL}
                    alt={signedInProfile.displayName}
                    referrerPolicy="no-referrer"
                    className="h-7 w-7 rounded-full border border-slate-700 shrink-0"
                  />
                ) : (
                  <span className="h-7 w-7 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center shrink-0">
                    {signedInProfile.displayName.charAt(0).toUpperCase()}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="font-medium text-slate-100 truncate">
                    {signedInProfile.displayName}
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {signedInProfile.email}
                  </div>
                </div>
              </div>
              {isCloudSynced ? (
                <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-medium">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                  Saved to cloud
                </div>
              ) : (
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Local session active. Connect Google to sync across devices.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="font-medium text-slate-300">CRM Sync Bridges</div>
            {connectors.map((c) => (
              <div key={c.platform} className="flex items-center justify-between">
                <span className="text-slate-400">
                  {c.platform === 'salesforce' ? 'Salesforce' : 'Zendesk'}
                </span>
                <span
                  className={`font-medium ${
                    c.connected ? 'text-emerald-400' : 'text-slate-500'
                  }`}
                >
                  {c.connected ? 'Connected' : 'Paused'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 md:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-68 bg-slate-950 text-slate-100 h-full border-r border-slate-900 flex flex-col z-50">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-800/80">
              <div className="flex items-center gap-2.5">
                <div className="h-7 w-7 rounded-lg bg-blue-600 flex items-center justify-center shrink-0">
                  <AudioLines className="h-3.5 w-3.5 text-white" />
                </div>
                <span className="text-base font-semibold text-white">Meridian Voice</span>
              </div>
              <button
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav aria-label="Mobile sections" className="flex-1 p-3 space-y-1">
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
                    className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium rounded-lg ${
                      active ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    <Icon className={`h-4 w-4 ${active ? 'text-blue-400' : 'text-slate-500'}`} />
                    {item.label}
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-800 text-xs space-y-2.5">
              <div className="font-medium text-white truncate">
                {signedInProfile.displayName}
              </div>
              <div className="text-[11px] text-slate-400 truncate">
                {signedInProfile.email}
              </div>
              {!isCloudSynced && (
                <button
                  type="button"
                  disabled={!authReady || isSigningIn}
                  onClick={() => {
                    setMobileMenuOpen(false);
                    void handleGoogleSignIn();
                  }}
                  className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-900 bg-white hover:bg-slate-100 rounded-lg"
                >
                  <GoogleMark />
                  {isSigningIn ? 'Syncing...' : 'Sync with Google'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  void handleSignOut();
                }}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign Out
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Workspace Header */}
        <header className="h-16 bg-white/95 backdrop-blur-xs border-b border-slate-200/90 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-20">
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

          <div className="flex items-center gap-2.5 shrink-0">
            <div className="flex items-center gap-2 border-r border-slate-200 pr-2.5">
              {authUser?.photoURL ? (
                <img
                  src={authUser.photoURL}
                  alt={signedInProfile.displayName}
                  referrerPolicy="no-referrer"
                  className="h-7 w-7 rounded-full border border-slate-200 shrink-0"
                />
              ) : (
                <span className="h-7 w-7 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center justify-center shrink-0">
                  {signedInProfile.displayName.charAt(0).toUpperCase()}
                </span>
              )}
              <div className="hidden sm:block text-left leading-tight">
                <div className="text-xs font-medium text-slate-900 max-w-[140px] truncate">
                  {signedInProfile.displayName}
                </div>
                <div className={`text-[11px] ${isCloudSynced ? 'text-emerald-700' : 'text-slate-500'}`}>
                  {isCloudSynced ? 'Cloud Synced' : signedInProfile.email}
                </div>
              </div>
              {!isCloudSynced && (
                <button
                  type="button"
                  disabled={!authReady || isSigningIn}
                  onClick={() => void handleGoogleSignIn()}
                  data-testid="google-signin-button"
                  title="Sync session with Google Account"
                  className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
                >
                  <GoogleMark />
                  <span>{isSigningIn ? 'Syncing...' : 'Sync Google'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleSignOut()}
                aria-label="Sign out"
                data-testid="signout-button"
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 hover:text-slate-900 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Sign Out</span>
              </button>
            </div>

            {isVoiceConnected ? (
              <button
                type="button"
                onClick={() => void stopVoiceSession()}
                className="inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 shadow-xs transition-colors whitespace-nowrap shrink-0"
              >
                <PhoneOff className="h-3.5 w-3.5" />
                <span className="sm:hidden">End</span>
                <span className="hidden sm:inline">End Live Voice</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setActiveSection('console');
                  void startVoiceSession({
                    customerName: signedInProfile.displayName,
                    company: signedInProfile.company,
                    customerEmail: signedInProfile.email,
                    slaTier: 'Enterprise',
                    platform: signedInProfile.targetPlatform,
                  });
                }}
                className="inline-flex items-center gap-1.5 px-3.5 sm:px-4 py-2 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 shadow-xs transition-colors whitespace-nowrap shrink-0"
              >
                <PhoneCall className="h-3.5 w-3.5" />
                <span className="sm:hidden">Live Voice</span>
                <span className="hidden sm:inline">Start Live Voice</span>
              </button>
            )}
          </div>
        </header>

        {/* Active View Viewport */}
        <main className="flex-1 p-4 sm:p-6 lg:p-7 max-w-[1440px] w-full mx-auto">
          {activeSection === 'console' && (
            <LiveCallConsole
              isVoiceConnected={isVoiceConnected}
              voiceMode={voiceMode}
              voiceNotice={voiceNotice}
              isMicMuted={isMicMuted}
              isMicUnavailable={isMicUnavailable}
              isVoiceOutputEnabled={isVoiceOutputEnabled}
              onToggleVoiceOutput={handleToggleVoiceOutput}
              isAgentSpeaking={isAgentSpeaking || isReplyAnimating}
              audioAmplitude={audioAmplitude}
              voicePersona={voicePersona}
              onVoicePersonaChange={setVoicePersona}
              selectedLanguage={selectedLanguage}
              activeLanguage={activeLanguage}
              switchPending={switchPending}
              onLanguageChange={handleLanguageSelectChange}
              onStartVoice={startVoiceSession}
              onStopVoice={() => void stopVoiceSession()}
              onToggleMute={() =>
                setIsMicMuted((m) => {
                  const nextMuted = !m;
                  if (nextMuted && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'flush_audio' }));
                  }
                  return nextMuted;
                })
              }
              turns={turns}
              activeTicket={activeTicket}
              latestNlu={latestNlu}
              isProcessingTurn={isProcessingTurn}
              errorMessage={errorMessage}
              onSendTurn={handleSendTurn}
              onResetSession={handleResetSession}
              onSyncTicket={handleSyncTicket}
              onOpenTicketQueue={() => setActiveSection('tickets')}
              signedInUser={signedInProfile}
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
