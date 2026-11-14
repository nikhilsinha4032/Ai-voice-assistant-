import type {
  CrmPlatform,
  CrmTicket,
  NluAnalysis,
  PriorityLevel,
  SentimentLabel,
  TicketFilters,
  TranscriptTurn,
  TriageRule,
  ZendeskPriority,
} from '../types/support.ts';

export interface TriageDecision {
  priority: PriorityLevel;
  zendeskPriority: ZendeskPriority;
  slaMinutes: number;
  tags: string[];
  escalated: boolean;
  matchedRuleName: string;
}

export function mapPriorityToZendesk(priority: PriorityLevel): ZendeskPriority {
  switch (priority) {
    case 'P1':
      return 'urgent';
    case 'P2':
      return 'high';
    case 'P3':
      return 'normal';
    case 'P4':
      return 'low';
  }
}

export function mapPriorityToSalesforceLabel(priority: PriorityLevel): string {
  switch (priority) {
    case 'P1':
      return 'Critical';
    case 'P2':
      return 'High';
    case 'P3':
      return 'Medium';
    case 'P4':
      return 'Low';
  }
}

export function deriveSentimentLabel(score: number): SentimentLabel {
  if (score <= -0.3) return 'Negative';
  if (score < 0.15) return 'Mixed';
  if (score >= 0.45) return 'Positive';
  return 'Neutral';
}

const PRIORITY_RANK: Record<PriorityLevel, number> = {
  P1: 1,
  P2: 2,
  P3: 3,
  P4: 4,
};

export function computeTicketPriority(
  analysis: NluAnalysis,
  slaTier: 'Enterprise' | 'Growth' | 'Standard',
  rules: TriageRule[]
): TriageDecision {
  let chosenPriority: PriorityLevel = 'P4';
  let slaMinutes = 1440;
  let escalated = false;
  let matchedRuleName = 'Default Baseline Routing';
  const tagSet = new Set<string>([
    `intent:${analysis.intent}`,
    `sentiment:${analysis.sentiment.toLowerCase()}`,
    `tier:${slaTier.toLowerCase()}`,
  ]);

  // Evaluate configured triage rules and take the highest-severity match
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const intentMatch =
      rule.intents.length === 0 || rule.intents.includes(analysis.intent);
    const sentimentMatch = analysis.sentimentScore <= rule.maxSentimentScore;

    if (intentMatch && sentimentMatch) {
      if (PRIORITY_RANK[rule.assignPriority] < PRIORITY_RANK[chosenPriority]) {
        chosenPriority = rule.assignPriority;
        slaMinutes = rule.slaMinutes;
        matchedRuleName = rule.name;
      }
      if (rule.escalateToTier2) {
        escalated = true;
      }
      for (const tag of rule.autoTags) {
        tagSet.add(tag);
      }
    }
  }

  // Deterministic urgency keyword / SLA boost
  if (analysis.urgencySignals.length >= 2 || analysis.sentimentScore <= -0.7) {
    if (PRIORITY_RANK['P1'] < PRIORITY_RANK[chosenPriority]) {
      chosenPriority = 'P1';
      slaMinutes = Math.min(slaMinutes, 15);
      matchedRuleName = 'Critical Sentiment & Urgency Guardrail';
    }
    escalated = true;
    tagSet.add('priority:p1-escalation');
  } else if (
    slaTier === 'Enterprise' &&
    analysis.sentimentScore < 0 &&
    PRIORITY_RANK['P2'] < PRIORITY_RANK[chosenPriority]
  ) {
    chosenPriority = 'P2';
    slaMinutes = Math.min(slaMinutes, 60);
    matchedRuleName = 'Enterprise SLA Priority Boost';
  } else if (
    chosenPriority === 'P4' &&
    (analysis.sentiment === 'Negative' || analysis.urgencySignals.length > 0)
  ) {
    chosenPriority = 'P3';
    slaMinutes = 240;
  }

  if (escalated) {
    tagSet.add('escalated-tier2');
  }
  tagSet.add(`sla:${slaMinutes}m`);

  return {
    priority: chosenPriority,
    zendeskPriority: mapPriorityToZendesk(chosenPriority),
    slaMinutes,
    tags: Array.from(tagSet),
    escalated,
    matchedRuleName,
  };
}

export function buildSalesforceCasePayload(
  ticket: Pick<
    CrmTicket,
    | 'customerName'
    | 'customerEmail'
    | 'company'
    | 'subject'
    | 'priority'
    | 'sentiment'
    | 'sentimentScore'
    | 'intent'
    | 'tags'
    | 'summary'
    | 'slaTier'
  >
) {
  return {
    Object: 'Case',
    Origin: 'Voice AI',
    Subject: ticket.subject,
    Status: ticket.priority === 'P1' ? 'Escalated' : 'Working',
    Priority: mapPriorityToSalesforceLabel(ticket.priority),
    Type: ticket.intent,
    SuppliedName: ticket.customerName,
    SuppliedEmail: ticket.customerEmail,
    SuppliedCompany: ticket.company,
    Sentiment_Score__c: Number(ticket.sentimentScore.toFixed(2)),
    Sentiment_Label__c: ticket.sentiment,
    SLA_Tier__c: ticket.slaTier,
    Auto_Tags__c: ticket.tags.join(';'),
    Description: ticket.summary,
  };
}

export function buildZendeskTicketPayload(
  ticket: Pick<
    CrmTicket,
    | 'customerName'
    | 'customerEmail'
    | 'subject'
    | 'zendeskPriority'
    | 'sentiment'
    | 'sentimentScore'
    | 'intent'
    | 'tags'
    | 'summary'
  >
) {
  return {
    ticket: {
      subject: ticket.subject,
      priority: ticket.zendeskPriority,
      type: ticket.intent.includes('outage') ? 'incident' : 'problem',
      status: ticket.zendeskPriority === 'urgent' ? 'open' : 'pending',
      requester: {
        name: ticket.customerName,
        email: ticket.customerEmail,
      },
      tags: [...ticket.tags, 'voice-ai', `sentiment-${ticket.sentiment.toLowerCase()}`],
      comment: {
        body: ticket.summary,
        public: false,
      },
      custom_fields: [
        { id: 'sentiment_score', value: Number(ticket.sentimentScore.toFixed(2)) },
        { id: 'nlu_intent', value: ticket.intent },
      ],
    },
  };
}

export interface RollingMetrics {
  avgLatencyMs: number;
  p95LatencyMs: number;
  latestSentimentScore: number;
  sentimentDelta: number;
  turnCount: number;
}

export function calculateRollingMetrics(turns: TranscriptTurn[]): RollingMetrics {
  const agentLatencies = turns
    .filter((t) => t.speaker === 'agent' && typeof t.latencyMs === 'number')
    .map((t) => t.latencyMs as number);

  const avgLatencyMs =
    agentLatencies.length > 0
      ? Math.round(agentLatencies.reduce((sum, v) => sum + v, 0) / agentLatencies.length)
      : 0;

  let p95LatencyMs = 0;
  if (agentLatencies.length > 0) {
    const sorted = [...agentLatencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    p95LatencyMs = sorted[idx];
  }

  const sentimentTurns = turns
    .filter((t) => t.nlu && typeof t.nlu.sentimentScore === 'number')
    .map((t) => (t.nlu as NluAnalysis).sentimentScore);

  const latestSentimentScore =
    sentimentTurns.length > 0 ? sentimentTurns[sentimentTurns.length - 1] : 0;
  const previousSentimentScore =
    sentimentTurns.length > 1 ? sentimentTurns[sentimentTurns.length - 2] : latestSentimentScore;

  return {
    avgLatencyMs,
    p95LatencyMs,
    latestSentimentScore,
    sentimentDelta: Number((latestSentimentScore - previousSentimentScore).toFixed(2)),
    turnCount: turns.length,
  };
}

export function filterTickets(
  tickets: CrmTicket[],
  filters: TicketFilters
): CrmTicket[] {
  const query = filters.search.trim().toLowerCase();
  return tickets.filter((t) => {
    if (filters.platform !== 'all' && t.platform !== filters.platform) {
      return false;
    }
    if (filters.priority !== 'all' && t.priority !== filters.priority) {
      return false;
    }
    if (filters.sentiment !== 'all' && t.sentiment !== filters.sentiment) {
      return false;
    }
    if (query.length > 0) {
      const haystack = [
        t.externalId,
        t.customerName,
        t.company,
        t.subject,
        t.intent,
        ...t.tags,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

export function generateExternalTicketId(platform: CrmPlatform, sequence: number): string {
  const num = 500800 + sequence;
  return platform === 'salesforce' ? `SF-${num}` : `ZD-${94100 + sequence}`;
}
