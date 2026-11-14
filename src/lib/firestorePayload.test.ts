import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConnectorCreatePayload,
  buildRuleCreatePayload,
  buildTicketCreatePayload,
  buildTicketNluUpdatePayload,
  buildTurnCreatePayload,
  buildUserProfileCreatePayload,
  sanitizeDocId,
} from './firestorePayload.ts';
import {
  DEFAULT_TRIAGE_RULES,
  INITIAL_CONNECTORS,
  INITIAL_TICKETS,
} from './seedData.ts';

test('sanitizeDocId enforces alphanumeric/hyphen/underscore pattern and max 128 chars', () => {
  assert.equal(sanitizeDocId('tkt-101'), 'tkt-101');
  assert.match(sanitizeDocId('weird id!@#$%^&*()'), /^[a-zA-Z0-9_-]+$/);
  assert.equal(sanitizeDocId('a'.repeat(300)).length, 128);
});

test('buildUserProfileCreatePayload matches blueprint required and optional fields without undefined', () => {
  const ts = { _server: true };
  const payload = buildUserProfileCreatePayload(
    'user-123',
    {
      displayName: 'A'.repeat(200),
      email: 'rohan@example.com',
      photoURL: null,
      activeTicketId: 'tkt-101',
      activeLanguage: 'Hindi',
    },
    ts,
    ts
  );
  assert.equal(payload.ownerId, 'user-123');
  assert.equal((payload.displayName as string).length, 120);
  assert.equal('photoURL' in payload, false);
  assert.equal(payload.activeTicketId, 'tkt-101');
  assert.equal(payload.activeLanguage, 'Hindi');
});

test('buildTicketCreatePayload truncates long summaries and tags and preserves createdAtIso', () => {
  const ts = { _server: true };
  const sample = {
    ...INITIAL_TICKETS[0],
    summary: 'S'.repeat(2000),
    tags: Array.from({ length: 40 }, (_, i) => `tag-${i}`),
    sentimentScore: -99,
  };
  const payload = buildTicketCreatePayload('user-123', sample, ts, ts);
  assert.equal(payload.ownerId, 'user-123');
  assert.equal(payload.summary.length, 1000);
  assert.equal(payload.tags.length, 25);
  assert.equal(payload.sentimentScore, -1);
  assert.equal(payload.createdAtIso, INITIAL_TICKETS[0].createdAt);

  const nluUpdate = buildTicketNluUpdatePayload(sample, ts);
  assert.equal('ownerId' in nluUpdate, false);
  assert.equal('createdAt' in nluUpdate, false);
});

test('buildTurnCreatePayload omits undefined optional properties and strips excess nlu keys', () => {
  const ts = { _server: true };
  const turn = buildTurnCreatePayload(
    'user-123',
    {
      id: 'turn-1',
      speaker: 'caller',
      text: 'नमस्ते, मेरा पेमेंट फेल हो गया है।',
      timestamp: '10:00:01',
      channel: 'voice',
      language: 'Hindi',
      nlu: {
        intent: 'outage_escalation',
        confidence: 0.94,
        sentiment: 'Negative',
        sentimentScore: -0.7,
        emotion: 'frustrated',
        urgencySignals: ['failed payments'],
        entities: [{ type: 'service', value: 'payment API' }],
        summary: 'Payment failure escalation',
        language: 'Hindi',
      },
    },
    ts,
    ts
  );

  assert.equal(turn.ownerId, 'user-123');
  assert.equal('latencyMs' in turn, false);
  assert.equal('previousLanguage' in turn, false);
  assert.ok(turn.nlu);
});

test('buildRuleCreatePayload and buildConnectorCreatePayload respect bounds', () => {
  const ts = { _server: true };
  const rule = buildRuleCreatePayload('user-123', DEFAULT_TRIAGE_RULES[0], ts, ts);
  assert.equal(rule.id, 'rule-outage-p1');
  assert.equal(rule.assignPriority, 'P1');

  const conn = buildConnectorCreatePayload('user-123', INITIAL_CONNECTORS[0], ts, ts);
  assert.equal(conn.platform, 'salesforce');
  assert.equal(conn.ownerId, 'user-123');
});
