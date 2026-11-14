import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSalesforceCasePayload,
  buildZendeskTicketPayload,
  calculateRollingMetrics,
  computeTicketPriority,
  deriveSentimentLabel,
  filterTickets,
} from './triage';
import { DEFAULT_TRIAGE_RULES, INITIAL_TICKETS } from './seedData';
import type { NluAnalysis, TranscriptTurn } from '../types/support';

test('computeTicketPriority escalates critical outage with negative sentiment to P1 / urgent', () => {
  const analysis: NluAnalysis = {
    intent: 'outage_escalation',
    confidence: 0.96,
    sentiment: 'Negative',
    sentimentScore: -0.82,
    emotion: 'Urgent',
    urgencySignals: ['production down', 'SLA breach'],
    entities: [{ type: 'Region', value: 'us-west-2' }],
    summary: 'Production API outage affecting customer checkout.',
  };

  const decision = computeTicketPriority(analysis, 'Enterprise', DEFAULT_TRIAGE_RULES);
  assert.equal(decision.priority, 'P1');
  assert.equal(decision.zendeskPriority, 'urgent');
  assert.equal(decision.slaMinutes, 15);
  assert.equal(decision.escalated, true);
  assert.ok(decision.tags.includes('outage'));
  assert.ok(decision.tags.includes('escalated-tier2'));
});

test('computeTicketPriority assigns P2 / high to billing dispute with negative sentiment', () => {
  const analysis: NluAnalysis = {
    intent: 'billing_dispute',
    confidence: 0.91,
    sentiment: 'Negative',
    sentimentScore: -0.45,
    emotion: 'Frustrated',
    urgencySignals: ['double charge'],
    entities: [{ type: 'Invoice', value: 'INV-9042' }],
    summary: 'Duplicate charge on corporate card.',
  };

  const decision = computeTicketPriority(analysis, 'Growth', DEFAULT_TRIAGE_RULES);
  assert.equal(decision.priority, 'P2');
  assert.equal(decision.zendeskPriority, 'high');
  assert.equal(decision.slaMinutes, 60);
  assert.ok(decision.tags.includes('billing-ops'));
});

test('computeTicketPriority assigns P4 / low to positive renewal inquiry', () => {
  const analysis: NluAnalysis = {
    intent: 'account_renewal',
    confidence: 0.94,
    sentiment: 'Positive',
    sentimentScore: 0.78,
    emotion: 'Satisfied',
    urgencySignals: [],
    entities: [{ type: 'Seats', value: '80' }],
    summary: 'Customer wants to expand 80 seats.',
  };

  const decision = computeTicketPriority(analysis, 'Enterprise', DEFAULT_TRIAGE_RULES);
  assert.equal(decision.priority, 'P4');
  assert.equal(decision.zendeskPriority, 'low');
  assert.equal(decision.escalated, false);
});

test('buildSalesforceCasePayload and buildZendeskTicketPayload map fields accurately', () => {
  const sample = INITIAL_TICKETS[0];
  const sfPayload = buildSalesforceCasePayload(sample);
  assert.equal(sfPayload.Object, 'Case');
  assert.equal(sfPayload.Origin, 'Voice AI');
  assert.equal(sfPayload.Priority, 'Critical');
  assert.equal(sfPayload.Status, 'Escalated');

  const zdPayload = buildZendeskTicketPayload(sample);
  assert.equal(zdPayload.ticket.priority, 'urgent');
  assert.equal(zdPayload.ticket.type, 'incident');
  assert.ok(zdPayload.ticket.tags.includes('voice-ai'));
});

test('calculateRollingMetrics computes average, p95 latency, and sentiment delta', () => {
  const turns: TranscriptTurn[] = [
    {
      id: '1',
      speaker: 'caller',
      text: 'Issue started.',
      timestamp: '02:40:00',
      channel: 'voice',
      nlu: {
        intent: 'outage_escalation',
        confidence: 0.9,
        sentiment: 'Negative',
        sentimentScore: -0.8,
        emotion: 'Urgent',
        urgencySignals: ['down'],
        entities: [],
        summary: 'Outage',
      },
    },
    {
      id: '2',
      speaker: 'agent',
      text: 'Opening bridge.',
      timestamp: '02:40:01',
      latencyMs: 240,
      channel: 'voice',
    },
    {
      id: '3',
      speaker: 'caller',
      text: 'Thank you.',
      timestamp: '02:40:20',
      channel: 'voice',
      nlu: {
        intent: 'outage_escalation',
        confidence: 0.9,
        sentiment: 'Mixed',
        sentimentScore: -0.2,
        emotion: 'Relieved',
        urgencySignals: [],
        entities: [],
        summary: 'Calming down',
      },
    },
    {
      id: '4',
      speaker: 'agent',
      text: 'Bridge active.',
      timestamp: '02:40:21',
      latencyMs: 320,
      channel: 'voice',
    },
  ];

  const metrics = calculateRollingMetrics(turns);
  assert.equal(metrics.avgLatencyMs, 280);
  assert.equal(metrics.p95LatencyMs, 320);
  assert.equal(metrics.latestSentimentScore, -0.2);
  assert.equal(metrics.sentimentDelta, 0.6);
});

test('filterTickets filters by platform, priority, sentiment, and search query', () => {
  const sfOnly = filterTickets(INITIAL_TICKETS, {
    platform: 'salesforce',
    priority: 'all',
    sentiment: 'all',
    search: '',
  });
  assert.equal(sfOnly.length, 2);

  const p1Search = filterTickets(INITIAL_TICKETS, {
    platform: 'all',
    priority: 'P1',
    sentiment: 'Negative',
    search: 'Northstar',
  });
  assert.equal(p1Search.length, 1);
  assert.equal(p1Search[0].externalId, 'SF-500814');

  assert.equal(deriveSentimentLabel(-0.5), 'Negative');
  assert.equal(deriveSentimentLabel(0.6), 'Positive');
});
