import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Timestamp,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase.ts';
import type {
  CrmConnectorConfig,
  CrmPlatform,
  CrmTicket,
  TranscriptTurn,
  TriageRule,
} from '../types/support.ts';
import {
  buildConnectorCreatePayload,
  buildConnectorUpdatePayload,
  buildRuleCreatePayload,
  buildRuleUpdatePayload,
  buildTicketCreatePayload,
  buildTicketManualEditPayload,
  buildTicketNluUpdatePayload,
  buildTicketSyncUpdatePayload,
  buildTurnCreatePayload,
  buildTurnUpdatePayload,
  buildUserProfileCreatePayload,
  buildUserProfileSessionUpdatePayload,
  sanitizeDocId,
  type UserSessionProfile,
} from './firestorePayload.ts';

function toEpochMs(value: unknown): number {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    const fn = (value as Timestamp).toMillis;
    if (typeof fn === 'function') {
      return fn.call(value);
    }
  }
  return 0;
}

const pendingTicketOps = new Map<string, Promise<void>>();
const pendingTurnOps = new Map<string, Promise<void>>();

function enqueueDocOp(
  queueMap: Map<string, Promise<void>>,
  key: string,
  task: () => Promise<void>
): Promise<void> {
  const previous = queueMap.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const cleanup = next.finally(() => {
    if (queueMap.get(key) === cleanup) {
      queueMap.delete(key);
    }
  });
  queueMap.set(key, cleanup);
  return next;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code) : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'not-found' || message.includes('No document to update');
}

function ticketFromDoc(data: Record<string, unknown>): CrmTicket {
  return {
    id: String(data.id || ''),
    externalId: String(data.externalId || ''),
    platform: data.platform === 'zendesk' ? 'zendesk' : 'salesforce',
    customerName: String(data.customerName || ''),
    company: String(data.company || ''),
    customerEmail: String(data.customerEmail || ''),
    slaTier:
      data.slaTier === 'Enterprise' ||
      data.slaTier === 'Growth' ||
      data.slaTier === 'Standard'
        ? data.slaTier
        : 'Standard',
    subject: String(data.subject || ''),
    intent: String(data.intent || ''),
    sentiment:
      data.sentiment === 'Positive' ||
      data.sentiment === 'Neutral' ||
      data.sentiment === 'Mixed' ||
      data.sentiment === 'Negative'
        ? data.sentiment
        : 'Neutral',
    sentimentScore: Number(data.sentimentScore ?? 0),
    priority:
      data.priority === 'P1' ||
      data.priority === 'P2' ||
      data.priority === 'P3' ||
      data.priority === 'P4'
        ? data.priority
        : 'P3',
    zendeskPriority:
      data.zendeskPriority === 'urgent' ||
      data.zendeskPriority === 'high' ||
      data.zendeskPriority === 'normal' ||
      data.zendeskPriority === 'low'
        ? data.zendeskPriority
        : 'normal',
    slaMinutes: Number(data.slaMinutes ?? 240),
    tags: Array.isArray(data.tags) ? data.tags.map((t) => String(t)) : [],
    status:
      data.status === 'New' ||
      data.status === 'In Progress' ||
      data.status === 'Escalated' ||
      data.status === 'Resolved'
        ? data.status
        : 'New',
    syncStatus:
      data.syncStatus === 'Synced' ||
      data.syncStatus === 'Pending' ||
      data.syncStatus === 'Failed'
        ? data.syncStatus
        : 'Synced',
    lastSyncedAt: String(data.lastSyncedAt || ''),
    avgLatencyMs: Number(data.avgLatencyMs ?? 0),
    summary: String(data.summary || ''),
    createdAt: String(data.createdAtIso || new Date().toISOString()),
  };
}

function turnFromDoc(data: Record<string, unknown>): TranscriptTurn & { _sortMs: number } {
  const turn: TranscriptTurn & { _sortMs: number } = {
    id: String(data.id || ''),
    speaker:
      data.speaker === 'agent' || data.speaker === 'system' ? data.speaker : 'caller',
    text: String(data.text || ''),
    timestamp: String(data.timestamp || ''),
    channel: data.channel === 'voice' ? 'voice' : 'text',
    _sortMs: toEpochMs(data.createdAt),
  };
  if (typeof data.latencyMs === 'number') turn.latencyMs = data.latencyMs;
  if (typeof data.language === 'string') turn.language = data.language;
  if (typeof data.previousLanguage === 'string') turn.previousLanguage = data.previousLanguage;
  if (data.nlu && typeof data.nlu === 'object') {
    turn.nlu = data.nlu as TranscriptTurn['nlu'];
  }
  return turn;
}

function ruleFromDoc(data: Record<string, unknown>): TriageRule {
  return {
    id: String(data.id || ''),
    name: String(data.name || ''),
    description: String(data.description || ''),
    enabled: Boolean(data.enabled),
    maxSentimentScore: Number(data.maxSentimentScore ?? 0),
    intents: Array.isArray(data.intents) ? data.intents.map((i) => String(i)) : [],
    assignPriority:
      data.assignPriority === 'P1' ||
      data.assignPriority === 'P2' ||
      data.assignPriority === 'P3' ||
      data.assignPriority === 'P4'
        ? data.assignPriority
        : 'P3',
    slaMinutes: Number(data.slaMinutes ?? 240),
    autoTags: Array.isArray(data.autoTags) ? data.autoTags.map((t) => String(t)) : [],
    escalateToTier2: Boolean(data.escalateToTier2),
  };
}

function connectorFromDoc(data: Record<string, unknown>): CrmConnectorConfig {
  return {
    platform: data.platform === 'zendesk' ? 'zendesk' : 'salesforce',
    displayName: String(data.displayName || ''),
    connected: Boolean(data.connected),
    instanceUrl: String(data.instanceUrl || ''),
    apiVersion: String(data.apiVersion || ''),
    autoSync: Boolean(data.autoSync),
    defaultQueue: String(data.defaultQueue || ''),
    lastSyncAt: String(data.lastSyncAt || ''),
    ticketsSyncedCount: Number(data.ticketsSyncedCount ?? 0),
  };
}

export async function ensureUserBootstrap(
  user: User,
  defaults: {
    tickets: CrmTicket[];
    rules: TriageRule[];
    connectors: CrmConnectorConfig[];
  },
  profileOverride?: {
    displayName?: string;
    company?: string;
    preferredLanguage?: string;
  } | null
): Promise<UserSessionProfile> {
  const uid = user.uid;
  const profilePath = `users/${uid}/private/profile`;
  const profileRef = doc(db, 'users', uid, 'private', 'profile');

  let profileData: UserSessionProfile = {
    ownerId: uid,
    displayName:
      profileOverride?.displayName?.trim() ||
      user.displayName ||
      user.email?.split('@')[0] ||
      'Customer',
    email: user.email || '',
    company: profileOverride?.company?.trim() || undefined,
    photoURL: user.photoURL || undefined,
    preferredLanguage: profileOverride?.preferredLanguage || 'auto',
  };

  let snap;
  try {
    snap = await getDoc(profileRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, profilePath);
  }

  if (!snap.exists()) {
    try {
      const payload = buildUserProfileCreatePayload(
        uid,
        {
          displayName: profileData.displayName,
          email: profileData.email,
          company: profileData.company,
          photoURL: user.photoURL,
          preferredLanguage: profileData.preferredLanguage || 'auto',
          activeTicketId: '',
          activeLanguage: '',
        },
        serverTimestamp(),
        serverTimestamp()
      );
      await setDoc(profileRef, payload);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, profilePath);
    }
  } else {
    const data = snap.data() as Record<string, unknown>;
    profileData = {
      ownerId: uid,
      displayName: String(data.displayName || profileData.displayName),
      email: String(data.email || profileData.email),
      company:
        typeof data.company === 'string' && data.company.length > 0
          ? data.company
          : profileData.company,
      photoURL: typeof data.photoURL === 'string' ? data.photoURL : undefined,
      preferredLanguage:
        typeof data.preferredLanguage === 'string' ? data.preferredLanguage : undefined,
      activeTicketId:
        typeof data.activeTicketId === 'string' && data.activeTicketId.length > 0
          ? data.activeTicketId
          : undefined,
      activeLanguage:
        typeof data.activeLanguage === 'string' && data.activeLanguage.length > 0
          ? data.activeLanguage
          : undefined,
    };
  }

  // Seed default rules if user has none yet
  const rulesPath = `users/${uid}/rules`;
  let rulesSnap;
  try {
    rulesSnap = await getDocs(
      query(collection(db, 'users', uid, 'rules'), where('ownerId', '==', uid))
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, rulesPath);
  }
  if (rulesSnap.empty && defaults.rules.length > 0) {
    try {
      const batch = writeBatch(db);
      for (const rule of defaults.rules) {
        const ruleId = sanitizeDocId(rule.id, 'rule');
        const payload = buildRuleCreatePayload(
          uid,
          { ...rule, id: ruleId },
          serverTimestamp(),
          serverTimestamp()
        );
        batch.set(doc(db, 'users', uid, 'rules', ruleId), payload);
      }
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, rulesPath);
    }
  }

  // Seed default connectors if user has none yet
  const connectorsPath = `users/${uid}/connectors`;
  let connSnap;
  try {
    connSnap = await getDocs(
      query(collection(db, 'users', uid, 'connectors'), where('ownerId', '==', uid))
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, connectorsPath);
  }
  if (connSnap.empty && defaults.connectors.length > 0) {
    try {
      const batch = writeBatch(db);
      for (const connector of defaults.connectors) {
        const payload = buildConnectorCreatePayload(
          uid,
          connector,
          serverTimestamp(),
          serverTimestamp()
        );
        batch.set(doc(db, 'users', uid, 'connectors', connector.platform), payload);
      }
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, connectorsPath);
    }
  }

  // Seed starter CRM tickets on first login so the queue reflects the workspace immediately
  const ticketsPath = `users/${uid}/tickets`;
  let ticketSnap;
  try {
    ticketSnap = await getDocs(
      query(collection(db, 'users', uid, 'tickets'), where('ownerId', '==', uid))
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, ticketsPath);
  }
  if (ticketSnap.empty && defaults.tickets.length > 0) {
    try {
      const batch = writeBatch(db);
      for (const ticket of defaults.tickets) {
        const ticketId = sanitizeDocId(ticket.id, 'tkt');
        const payload = buildTicketCreatePayload(
          uid,
          { ...ticket, id: ticketId },
          serverTimestamp(),
          serverTimestamp()
        );
        batch.set(doc(db, 'users', uid, 'tickets', ticketId), payload);
      }
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, ticketsPath);
    }
  }

  return profileData;
}

export function subscribeUserWorkspace(
  uid: string,
  callbacks: {
    onProfile: (profile: UserSessionProfile) => void;
    onTickets: (tickets: CrmTicket[]) => void;
    onTurns: (turns: TranscriptTurn[]) => void;
    onRules: (rules: TriageRule[]) => void;
    onConnectors: (connectors: CrmConnectorConfig[]) => void;
    onError: (error: Error) => void;
  }
): () => void {
  const report = (error: unknown, path: string, op: OperationType = OperationType.GET) => {
    try {
      handleFirestoreError(error, op, path);
    } catch (wrapped) {
      callbacks.onError(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
    }
  };

  const profilePath = `users/${uid}/private/profile`;
  const unsubProfile = onSnapshot(
    doc(db, 'users', uid, 'private', 'profile'),
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data() as Record<string, unknown>;
      callbacks.onProfile({
        ownerId: uid,
        displayName: String(data.displayName || 'Customer'),
        email: String(data.email || ''),
        company: typeof data.company === 'string' && data.company.length > 0 ? data.company : undefined,
        photoURL: typeof data.photoURL === 'string' ? data.photoURL : undefined,
        preferredLanguage:
          typeof data.preferredLanguage === 'string' ? data.preferredLanguage : undefined,
        activeTicketId:
          typeof data.activeTicketId === 'string' && data.activeTicketId.length > 0
            ? data.activeTicketId
            : undefined,
        activeLanguage:
          typeof data.activeLanguage === 'string' && data.activeLanguage.length > 0
            ? data.activeLanguage
            : undefined,
      });
    },
    (err) => report(err, profilePath, OperationType.GET)
  );

  const ticketsPath = `users/${uid}/tickets`;
  const unsubTickets = onSnapshot(
    query(collection(db, 'users', uid, 'tickets'), where('ownerId', '==', uid)),
    (snap) => {
      const items = snap.docs.map((d) => ticketFromDoc(d.data() as Record<string, unknown>));
      items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      callbacks.onTickets(items);
    },
    (err) => report(err, ticketsPath, OperationType.LIST)
  );

  const turnsPath = `users/${uid}/turns`;
  const unsubTurns = onSnapshot(
    query(collection(db, 'users', uid, 'turns'), where('ownerId', '==', uid)),
    (snap) => {
      const items = snap.docs.map((d) => turnFromDoc(d.data() as Record<string, unknown>));
      items.sort((a, b) => {
        const diff = a._sortMs - b._sortMs;
        if (diff !== 0) return diff;
        return a.id.localeCompare(b.id);
      });
      callbacks.onTurns(
        items.map(({ _sortMs: _ignored, ...rest }) => rest)
      );
    },
    (err) => report(err, turnsPath, OperationType.LIST)
  );

  const rulesPath = `users/${uid}/rules`;
  const unsubRules = onSnapshot(
    query(collection(db, 'users', uid, 'rules'), where('ownerId', '==', uid)),
    (snap) => {
      const items = snap.docs.map((d) => ruleFromDoc(d.data() as Record<string, unknown>));
      callbacks.onRules(items);
    },
    (err) => report(err, rulesPath, OperationType.LIST)
  );

  const connectorsPath = `users/${uid}/connectors`;
  const unsubConnectors = onSnapshot(
    query(collection(db, 'users', uid, 'connectors'), where('ownerId', '==', uid)),
    (snap) => {
      const items = snap.docs.map((d) => connectorFromDoc(d.data() as Record<string, unknown>));
      callbacks.onConnectors(items);
    },
    (err) => report(err, connectorsPath, OperationType.LIST)
  );

  return () => {
    unsubProfile();
    unsubTickets();
    unsubTurns();
    unsubRules();
    unsubConnectors();
  };
}

export async function saveUserSessionPrefs(
  uid: string,
  prefs: {
    preferredLanguage?: string;
    activeTicketId?: string | null;
    activeLanguage?: string | null;
  }
): Promise<void> {
  const path = `users/${uid}/private/profile`;
  try {
    await updateDoc(
      doc(db, 'users', uid, 'private', 'profile'),
      buildUserProfileSessionUpdatePayload(prefs, serverTimestamp())
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function upsertTicketInCloud(
  uid: string,
  ticket: CrmTicket,
  knownExisting: boolean
): Promise<void> {
  const ticketId = sanitizeDocId(ticket.id, 'tkt');
  const path = `users/${uid}/tickets/${ticketId}`;
  const ref = doc(db, 'users', uid, 'tickets', ticketId);

  return enqueueDocOp(pendingTicketOps, `${uid}/${ticketId}`, async () => {
    if (knownExisting) {
      try {
        await updateDoc(ref, buildTicketNluUpdatePayload(ticket, serverTimestamp()));
        return;
      } catch (error) {
        if (!isNotFoundError(error)) {
          handleFirestoreError(error, OperationType.UPDATE, path);
        }
      }
    }

    let snap;
    try {
      snap = await getDoc(ref);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, path);
    }

    if (snap.exists()) {
      if (snap.data()?.status === 'Resolved') return;
      try {
        await updateDoc(ref, buildTicketNluUpdatePayload(ticket, serverTimestamp()));
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, path);
      }
    } else {
      try {
        await setDoc(
          ref,
          buildTicketCreatePayload(
            uid,
            { ...ticket, id: ticketId },
            serverTimestamp(),
            serverTimestamp()
          )
        );
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, path);
      }
    }
  });
}

export async function updateTicketManualInCloud(
  uid: string,
  ticketId: string,
  patch: Partial<Pick<CrmTicket, 'status' | 'priority' | 'zendeskPriority' | 'slaMinutes' | 'tags'>>
): Promise<void> {
  const safeId = sanitizeDocId(ticketId, 'tkt');
  const path = `users/${uid}/tickets/${safeId}`;
  try {
    await updateDoc(
      doc(db, 'users', uid, 'tickets', safeId),
      buildTicketManualEditPayload(patch, serverTimestamp())
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function syncTicketInCloud(
  uid: string,
  ticketId: string,
  lastSyncedAt: string,
  platform?: CrmPlatform,
  nextSyncedCount?: number
): Promise<void> {
  const safeId = sanitizeDocId(ticketId, 'tkt');
  const path = `users/${uid}/tickets/${safeId}`;
  try {
    await updateDoc(
      doc(db, 'users', uid, 'tickets', safeId),
      buildTicketSyncUpdatePayload('Synced', lastSyncedAt, serverTimestamp())
    );
    if (platform && typeof nextSyncedCount === 'number') {
      await updateDoc(
        doc(db, 'users', uid, 'connectors', platform),
        buildConnectorUpdatePayload(
          { lastSyncAt: lastSyncedAt, ticketsSyncedCount: nextSyncedCount },
          serverTimestamp()
        )
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function upsertTurnInCloud(
  uid: string,
  turn: TranscriptTurn,
  isUpdate = false
): Promise<void> {
  const turnId = sanitizeDocId(turn.id, 'turn');
  const path = `users/${uid}/turns/${turnId}`;
  const ref = doc(db, 'users', uid, 'turns', turnId);

  return enqueueDocOp(pendingTurnOps, `${uid}/${turnId}`, async () => {
    if (isUpdate) {
      try {
        await updateDoc(
          ref,
          buildTurnUpdatePayload(
            {
              text: turn.text,
              latencyMs: turn.latencyMs,
              language: turn.language,
              nlu: turn.nlu,
            },
            serverTimestamp()
          )
        );
        return;
      } catch (error) {
        if (!isNotFoundError(error)) {
          handleFirestoreError(error, OperationType.UPDATE, path);
        }
      }
    }

    try {
      await setDoc(
        ref,
        buildTurnCreatePayload(
          uid,
          { ...turn, id: turnId },
          serverTimestamp(),
          serverTimestamp()
        )
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, path);
    }
  });
}

export async function clearTurnsInCloud(uid: string, turnIds: string[]): Promise<void> {
  if (turnIds.length === 0) return;
  const path = `users/${uid}/turns`;
  try {
    for (let i = 0; i < turnIds.length; i += 400) {
      const chunk = turnIds.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const rawId of chunk) {
        const safeId = sanitizeDocId(rawId, 'turn');
        batch.delete(doc(db, 'users', uid, 'turns', safeId));
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function updateRuleInCloud(
  uid: string,
  ruleId: string,
  patch: Partial<TriageRule>
): Promise<void> {
  const safeId = sanitizeDocId(ruleId, 'rule');
  const path = `users/${uid}/rules/${safeId}`;
  try {
    await updateDoc(
      doc(db, 'users', uid, 'rules', safeId),
      buildRuleUpdatePayload(patch, serverTimestamp())
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function updateConnectorInCloud(
  uid: string,
  platform: CrmPlatform,
  patch: Partial<CrmConnectorConfig>
): Promise<void> {
  const path = `users/${uid}/connectors/${platform}`;
  try {
    await updateDoc(
      doc(db, 'users', uid, 'connectors', platform),
      buildConnectorUpdatePayload(patch, serverTimestamp())
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
