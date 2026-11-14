export type CrmPlatform = 'salesforce' | 'zendesk';

export type PriorityLevel = 'P1' | 'P2' | 'P3' | 'P4';

export type ZendeskPriority = 'urgent' | 'high' | 'normal' | 'low';

export type SentimentLabel = 'Positive' | 'Neutral' | 'Mixed' | 'Negative';

export type VoicePersona = 'Zephyr' | 'Kore' | 'Fenrir' | 'Puck';

export interface ExtractedEntity {
  type: string;
  value: string;
}

export interface NluAnalysis {
  intent: string;
  confidence: number;
  sentiment: SentimentLabel;
  sentimentScore: number; // -1.0 to +1.0
  emotion: string;
  urgencySignals: string[];
  entities: ExtractedEntity[];
  summary: string;
  language?: string;
}

export interface TranscriptTurn {
  id: string;
  speaker: 'caller' | 'agent' | 'system';
  text: string;
  timestamp: string;
  latencyMs?: number;
  nlu?: NluAnalysis;
  channel: 'voice' | 'text';
  language?: string;
  previousLanguage?: string;
}

export interface TriageRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  maxSentimentScore: number; // Triggers when sentimentScore <= maxSentimentScore
  intents: string[];
  assignPriority: PriorityLevel;
  slaMinutes: number;
  autoTags: string[];
  escalateToTier2: boolean;
}

export interface CrmTicket {
  id: string;
  externalId: string;
  platform: CrmPlatform;
  customerName: string;
  company: string;
  customerEmail: string;
  slaTier: 'Enterprise' | 'Growth' | 'Standard';
  subject: string;
  intent: string;
  sentiment: SentimentLabel;
  sentimentScore: number;
  priority: PriorityLevel;
  zendeskPriority: ZendeskPriority;
  slaMinutes: number;
  tags: string[];
  status: 'New' | 'In Progress' | 'Escalated' | 'Resolved';
  syncStatus: 'Synced' | 'Pending' | 'Failed';
  lastSyncedAt: string;
  avgLatencyMs: number;
  summary: string;
  createdAt: string;
}

export interface CrmConnectorConfig {
  platform: CrmPlatform;
  displayName: string;
  connected: boolean;
  instanceUrl: string;
  apiVersion: string;
  autoSync: boolean;
  defaultQueue: string;
  lastSyncAt: string;
  ticketsSyncedCount: number;
}

export interface CallerScenario {
  id: string;
  title: string;
  customerName: string;
  company: string;
  customerEmail: string;
  slaTier: 'Enterprise' | 'Growth' | 'Standard';
  targetPlatform: CrmPlatform;
  utterance: string;
}

export interface TicketFilters {
  platform: 'all' | CrmPlatform;
  priority: 'all' | PriorityLevel;
  sentiment: 'all' | SentimentLabel;
  search: string;
}
