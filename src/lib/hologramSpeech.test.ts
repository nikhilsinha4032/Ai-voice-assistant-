import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSpeechEnvelope, estimateSpeechDurationMs } from './hologramSpeech.ts';

test('estimateSpeechDurationMs scales naturally with reply length within bounds', () => {
  assert.equal(estimateSpeechDurationMs(''), 0);
  assert.equal(estimateSpeechDurationMs('Hi there'), 2400);
  const medium = estimateSpeechDurationMs(
    'I have escalated your production API outage ticket to Tier-2 engineering with a 15 minute SLA.'
  );
  assert.ok(medium >= 4000 && medium <= 7500);
  const veryLong = estimateSpeechDurationMs(new Array(80).fill('word').join(' '));
  assert.equal(veryLong, 7500);
});

test('computeSpeechEnvelope closes jaw at idle and articulates mouth bars when speaking', () => {
  const idle = computeSpeechEnvelope(1.2, false, false, 0);
  assert.equal(idle.jawOpen, 0);
  assert.ok(idle.pulse < 0.2);

  const thinking = computeSpeechEnvelope(1.2, false, true, 0);
  assert.equal(thinking.jawOpen, 0);
  assert.ok(thinking.pulse > idle.pulse);

  const speaking = computeSpeechEnvelope(1.2, true, false, 0.35);
  assert.ok(speaking.jawOpen > 0.1);
  assert.ok(speaking.pulse > 0.5);
  assert.equal(speaking.barHeights.length, 7);
  assert.ok(speaking.barHeights.every((h) => h >= 0.15 && h <= 1));
});
