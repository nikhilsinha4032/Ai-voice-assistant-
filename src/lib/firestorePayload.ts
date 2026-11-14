import type {
  CrmConnectorConfig,
  CrmTicket,
  NluAnalysis,
  PriorityLevel,
  SentimentLabel,
  TranscriptTurn,
  TriageRule,
  ZendeskPriority,
} from '../types/support.ts';

export interface UserSessionProfile {
  ownerId: string;
  displayName: string;
  email: string;
  company?: string;
  photoURL?: string;
  preferredLanguage?: string;
  activeTicketId?: string;
  activeLanguage?: string;
}

const VALID_ID_CHARS = /[^a-zA-Z0-9_-]/g;

export function sanitizeDocId(rawId: string, fallbackPrefix = 'doc'): string {
  const cleaned = String(rawId || '')
    .replace(VALID_ID_CHARS, '_')
    .slice(0, 128);
  if (cleaned.length > 0 && /^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    return cleaned;
  }
  return `${fallbackPrefix}-${Date.now()}`;
}

export function clampString(value: unknown, maxLength: number, fallback = ''): string {
  const str = typeof value === 'string' ? value.trim() : '';
  const safe = str.length > 0 ? str : fallback;
  return safe.slice(0, maxLength);
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, num));
}

export function sanitizeStringArray(
  values: unknown,
  maxItems: number,
  maxItemLength: number
): string[] {
  if (!Array.isArray(values)) return [];
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().slice(0, maxItemLength);
    if (trimmed.length > 0 && !result.includes(trimmed)) {
      result.push(trimmed);
    }
    if (result.length >= maxItems) break;
  }
  return result;
}

function sanitizePriority(val: unknown): PriorityLevel {
  if (val === 'P1' || val === 'P2' || val === 'P3' || val === 'P4') return val;
  return 'P3';
}

function sanitizeZendeskPriority(val: unknown): ZendeskPriority {
  if (val === 'urgent' || val === 'high' || val === 'normal' || val === 'low') return val;
  return 'normal';
}

function sanitizeSentiment(val: unknown): SentimentLabel {
  if (val === 'Positive' || val === 'Neutral' || val === 'Mixed' || val === 'Negative') {
    return val;
  }
  return 'Neutral';
}

export function sanitizeNluAnalysis(nlu: NluAnalysis): NluAnalysis {
  const clean: NluAnalysis = {
    intent: clampString(nlu.intent, 80, 'general_inquiry'),
    confidence: clampNumber(nlu.confidence, 0, 1, 0.75),
    sentiment: sanitizeSentiment(nlu.sentiment),
    sentimentScore: clampNumber(nlu.sentimentScore, -1, 1, 0),
    emotion: clampString(nlu.emotion, 60, 'calm'),
    urgencySignals: sanitizeStringArray(nlu.urgencySignals, 10, 80),
    entities: Array.isArray(nlu.entities)
      ? nlu.entities.slice(0, 12).map((ent) => ({
          type: clampString(ent?.type, 40, 'entity'),
          value: clampString(ent?.value, 120, ''),
        }))
      : [],
    summary: clampString(nlu.summary, 1000, ''),
  };
  if (typeof nlu.language === 'string' && nlu.language.trim().length > 0) {
    clean.language = clampString(nlu.language, 40);
  }
  return clean;
}

export function buildUserProfileCreatePayload<T>(
  ownerId: string,
  input: {
    displayName: string;
    email: string;
    company?: string | null;
    photoURL?: string | null;
    preferredLanguage?: string;
    activeTicketId?: string | null;
    activeLanguage?: string | null;
  },
  createdTimestamp: T,
  updatedTimestamp: T
) {
  const payload: Record<string, unknown> = {
    ownerId: clampString(ownerId, 128),
    displayName: clampString(input.displayName, 120, 'Customer'),
    email: clampString(input.email, 180, 'customer@example.com'),
    createdAt: createdTimestamp,
    updatedAt: updatedTimestamp,
  };
  if (input.company && input.company.trim().length > 0) {
    payload.company = clampString(input.company, 120);
  }
  if (input.photoURL) {
    payload.photoURL = clampString(input.photoURL, 512);
  }
  if (input.preferredLanguage) {
    payload.preferredLanguage = clampString(input.preferredLanguage, 40);
  }
  if (input.activeTicketId !== undefined && input.activeTicketId !== null) {
    payload.activeTicketId =
      input.activeTicketId === '' ? '' : sanitizeDocId(input.activeTicketId, 'tkt');
  }
  if (input.activeLanguage) {
    payload.activeLanguage = clampString(input.activeLanguage, 40);
  }
  return payload;
}

export function buildUserProfileSessionUpdatePayload<T>(
  input: {
    preferredLanguage?: string;
    activeTicketId?: string | null;
    activeLanguage?: string | null;
  },
  updatedTimestamp: T
) {
  const payload: Record<string, unknown> = {
    updatedAt: updatedTimestamp,
  };
  if (input.preferredLanguage !== undefined) {
    payload.preferredLanguage = clampString(input.preferredLanguage, 40, 'auto');
  }
  if (input.activeTicketId !== undefined) {
    payload.activeTicketId =
      input.activeTicketId && input.activeTicketId.trim().length > 0
        ? sanitizeDocId(input.activeTicketId, 'tkt')
        : '';
  }
  if (input.activeLanguage !== undefined) {
    payload.activeLanguage = input.activeLanguage ? clampString(input.activeLanguage, 40) : '';
  }
  return payload;
}

export function buildTicketCreatePayload<T>(
  ownerId: string,
  ticket: CrmTicket,
  createdTimestamp: T,
  updatedTimestamp: T
) {
  const id = sanitizeDocId(ticket.id, 'tkt');
  return {
    ownerId: clampString(ownerId, 128),
    id,
    externalId: clampString(ticket.externalId, 40, id),
    platform: ticket.platform === 'zendesk' ? 'zendesk' : 'salesforce',
    customerName: clampString(ticket.customerName, 120, 'Customer'),
    company: clampString(ticket.company, 120, 'Customer Account'),
    customerEmail: clampString(ticket.customerEmail, 180, ''),
    slaTier:
      ticket.slaTier === 'Enterprise' ||
      ticket.slaTier === 'Growth' ||
      ticket.slaTier === 'Standard'
        ? ticket.slaTier
        : 'Standard',
    subject: clampString(ticket.subject, 240, 'Support Request'),
    intent: clampString(ticket.intent, 80, 'general_inquiry'),
    sentiment: sanitizeSentiment(ticket.sentiment),
    sentimentScore: clampNumber(ticket.sentimentScore, -1, 1, 0),
    priority: sanitizePriority(ticket.priority),
    zendeskPriority: sanitizeZendeskPriority(ticket.zendeskPriority),
    slaMinutes: clampNumber(ticket.slaMinutes, 1, 10080, 240),
    tags: sanitizeStringArray(ticket.tags, 25, 80),
    status:
      ticket.status === 'New' ||
      ticket.status === 'In Progress' ||
      ticket.status === 'Escalated' ||
      ticket.status === 'Resolved'
        ? ticket.status
        : 'New',
    syncStatus:
      ticket.syncStatus === 'Synced' ||
      ticket.syncStatus === 'Pending' ||
      ticket.syncStatus === 'Failed'
        ? ticket.syncStatus
        : 'Synced',
    lastSyncedAt: clampString(ticket.lastSyncedAt, 64, new Date().toISOString()),
    avgLatencyMs: clampNumber(ticket.avgLatencyMs, 0, 600000, 0),
    summary: clampString(ticket.summary, 1000, ''),
    createdAtIso: clampString(ticket.createdAt, 64, new Date().toISOString()),
    createdAt: createdTimestamp,
    updatedAt: updatedTimestamp,
  };
}

export function buildTicketNluUpdatePayload<T>(ticket: CrmTicket, updatedTimestamp: T) {
  return {
    subject: clampString(ticket.subject, 240, 'Support Request'),
    intent: clampString(ticket.intent, 80, 'general_inquiry'),
    sentiment: sanitizeSentiment(ticket.sentiment),
    sentimentScore: clampNumber(ticket.sentimentScore, -1, 1, 0),
    priority: sanitizePriority(ticket.priority),
    zendeskPriority: sanitizeZendeskPriority(ticket.zendeskPriority),
    slaMinutes: clampNumber(ticket.slaMinutes, 1, 10080, 240),
    tags: sanitizeStringArray(ticket.tags, 25, 80),
    status:
      ticket.status === 'New' ||
      ticket.status === 'In Progress' ||
      ticket.status === 'Escalated' ||
      ticket.status === 'Resolved'
        ? ticket.status
        : 'New',
    syncStatus:
      ticket.syncStatus === 'Synced' ||
      ticket.syncStatus === 'Pending' ||
      ticket.syncStatus === 'Failed'
        ? ticket.syncStatus
        : 'Synced',
    lastSyncedAt: clampString(ticket.lastSyncedAt, 64, new Date().toISOString()),
    avgLatencyMs: clampNumber(ticket.avgLatencyMs, 0, 600000, 0),
    summary: clampString(ticket.summary, 1000, ''),
    updatedAt: updatedTimestamp,
  };
}

export function buildTicketManualEditPayload<T>(
  patch: Partial<Pick<CrmTicket, 'status' | 'priority' | 'zendeskPriority' | 'slaMinutes' | 'tags'>>,
  updatedTimestamp: T
) {
  const payload: Record<string, unknown> = { updatedAt: updatedTimestamp };
  if (patch.status) payload.status = patch.status;
  if (patch.priority) payload.priority = sanitizePriority(patch.priority);
  if (patch.zendeskPriority) {
    payload.zendeskPriority = sanitizeZendeskPriority(patch.zendeskPriority);
  }
  if (typeof patch.slaMinutes === 'number') {
    payload.slaMinutes = clampNumber(patch.slaMinutes, 1, 10080, 240);
  }
  if (Array.isArray(patch.tags)) {
    payload.tags = sanitizeStringArray(patch.tags, 25, 80);
  }
  return payload;
}

export function buildTicketSyncUpdatePayload<T>(
  syncStatus: CrmTicket['syncStatus'],
  lastSyncedAt: string,
  updatedTimestamp: T
) {
  return {
    syncStatus,
    lastSyncedAt: clampString(lastSyncedAt, 64, new Date().toISOString()),
    updatedAt: updatedTimestamp,
  };
}

export function buildTurnCreatePayload<T>(
  ownerId: string,
  turn: TranscriptTurn,
  createdTimestamp: T,
  updatedTimestamp: T
) {
  const id = sanitizeDocId(turn.id, 'turn');
  const payload: Record<string, unknown> = {
    ownerId: clampString(ownerId, 128),
    id,
    speaker:
      turn.speaker === 'caller' || turn.speaker === 'agent' || turn.speaker === 'system'
        ? turn.speaker
        : 'caller',
    text: clampString(turn.text, 4000, '...'),
    timestamp: clampString(turn.timestamp, 32, '00:00:00'),
    channel: turn.channel === 'voice' ? 'voice' : 'text',
    createdAt: createdTimestamp,
    updatedAt: updatedTimestamp,
  };
  if (typeof turn.latencyMs === 'number' && Number.isFinite(turn.latencyMs)) {
    payload.latencyMs = clampNumber(turn.latencyMs, 0, 600000, 0);
  }
  if (typeof turn.language === 'string' && turn.language.trim().length > 0) {
    payload.language = clampString(turn.language, 40);
  }
  if (typeof turn.previousLanguage === 'string' && turn.previousLanguage.trim().length > 0) {
    payload.previousLanguage = clampString(turn.previousLanguage, 40);
  }
  if (turn.nlu) {
    payload.nlu = sanitizeNluAnalysis(turn.nlu);
  }
  return payload;
}

export function buildTurnUpdatePayload<T>(
  turn: Partial<Pick<TranscriptTurn, 'text' | 'latencyMs' | 'language' | 'nlu'>>,
  updatedTimestamp: T
) {
  const payload: Record<string, unknown> = { updatedAt: updatedTimestamp };
  if (typeof turn.text === 'string') {
    payload.text = clampString(turn.text, 4000, '...');
  }
  if (typeof turn.latencyMs === 'number' && Number.isFinite(turn.latencyMs)) {
    payload.latencyMs = clampNumber(turn.latencyMs, 0, 600000, 0);
  }
  if (typeof turn.language === 'string' && turn.language.trim().length > 0) {
    payload.language = clampString(turn.language, 40);
  }
  if (turn.nlu) {
    payload.nlu = sanitizeNluAnalysis(turn.nlu);
  }
  return payload;
}

export function buildRuleCreatePayload<T>(
  ownerId: string,
  rule: TriageRule,
  createdTimestamp: T,
  updatedTimestamp: T
) {
  const id = sanitizeDocId(rule.id, 'rule');
  return {
    ownerId: clampString(ownerId, 128),
    id,
    name: clampString(rule.name, 120, 'Triage Rule'),
    description: clampString(rule.description, 400, ''),
    enabled: Boolean(rule.enabled),
    maxSentimentScore: clampNumber(rule.maxSentimentScore, -1, 1, 0),
    intents: sanitizeStringArray(rule.intents, 20, 80),
    assignPriority: sanitizePriority(rule.assignPriority),
    slaMinutes: clampNumber(rule.slaMinutes, 1, 10080, 240),
    autoTags: sanitizeStringArray(rule.autoTags, 20, 80),
    escalateToTier2: Boolean(rule.escalateToTier2),
    createdAt: createdTimestamp,
    updatedAt: updatedTimestamp,
  };
}

export function buildRuleUpdatePayload<T>(patch: Partial<TriageRule>, updatedTimestamp: T) {
  const payload: Record<string, unknown> = { updatedAt: updatedTimestamp };
  if (typeof patch.enabled === 'boolean') payload.enabled = patch.enabled;
  if (patch.assignPriority) payload.assignPriority = sanitizePriority(patch.assignPriority);
  if (typeof patch.maxSentimentScore === 'number') {
    payload.maxSentimentScore = clampNumber(patch.maxSentimentScore, -1, 1, 0);
  }
  if (typeof patch.slaMinutes === 'number') {
    payload.slaMinutes = clampNumber(patch.slaMinutes, 1, 10080, 240);
  }
  if (typeof patch.escalateToTier2 === 'boolean') {
    payload.escalateToTier2 = patch.escalateToTier2;
  }
  if (Array.isArray(patch.intents)) {
    payload.intents = sanitizeStringArray(patch.intents, 20, 80);
  }
  if (Array.isArray(patch.autoTags)) {
    payload.autoTags = sanitizeStringArray(patch.autoTags, 20, 80);
  }
  return payload;
}

export function buildConnectorCreatePayload<T>(
  ownerId: string,
  connector: CrmConnectorConfig,
  createdTimestamp: T,
  updatedTimestamp: T
) {
  return {
    ownerId: clampString(ownerId, 128),
    platform: connector.platform === 'zendesk' ? 'zendesk' : 'salesforce',
    displayName: clampString(connector.displayName, 120, 'CRM Connector'),
    connected: Boolean(connector.connected),
    instanceUrl: clampString(connector.instanceUrl, 256, ''),
    apiVersion: clampString(connector.apiVersion, 32, 'v1'),
    autoSync: Boolean(connector.autoSync),
    defaultQueue: clampString(connector.defaultQueue, 120, 'Default'),
    lastSyncAt: clampString(connector.lastSyncAt, 64, new Date().toISOString()),
    ticketsSyncedCount: clampNumber(connector.ticketsSyncedCount, 0, 100000000, 0),
    createdAt: createdTimestamp,
    updatedAt: updatedTimestamp,
  };
}

export function buildConnectorUpdatePayload<T>(
  patch: Partial<CrmConnectorConfig>,
  updatedTimestamp: T
) {
  const payload: Record<string, unknown> = { updatedAt: updatedTimestamp };
  if (typeof patch.connected === 'boolean') payload.connected = patch.connected;
  if (typeof patch.instanceUrl === 'string') {
    payload.instanceUrl = clampString(patch.instanceUrl, 256, '');
  }
  if (typeof patch.autoSync === 'boolean') payload.autoSync = patch.autoSync;
  if (typeof patch.defaultQueue === 'string') {
    payload.defaultQueue = clampString(patch.defaultQueue, 120, 'Default');
  }
  if (typeof patch.lastSyncAt === 'string') {
    payload.lastSyncAt = clampString(patch.lastSyncAt, 64, new Date().toISOString());
  }
  if (typeof patch.ticketsSyncedCount === 'number') {
    payload.ticketsSyncedCount = clampNumber(patch.ticketsSyncedCount, 0, 100000000, 0);
  }
  return payload;
}
