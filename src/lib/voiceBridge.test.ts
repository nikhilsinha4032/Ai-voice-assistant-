import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMicrophoneError,
  computeInt16PcmRms,
  encodePcm16ToWav,
  isLiveApiQuotaOrUnavailableError,
  mapLanguageToBcp47,
  UtteranceVadAccumulator,
} from './voiceBridge';

function makePcmChunk(sampleCount: number, amplitude: number): Buffer {
  const buf = Buffer.alloc(sampleCount * 2);
  const val = Math.round(amplitude * 32767);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE(i % 2 === 0 ? val : -val, i * 2);
  }
  return buf;
}

test('computeInt16PcmRms returns 0 for silence and proportional RMS for tone', () => {
  const silent = makePcmChunk(1600, 0);
  assert.equal(computeInt16PcmRms(silent), 0);

  const loud = makePcmChunk(1600, 0.5);
  const rms = computeInt16PcmRms(loud);
  assert.ok(rms > 0.45 && rms < 0.55);
});

test('encodePcm16ToWav writes valid 44-byte RIFF/WAVE header', () => {
  const pcm = makePcmChunk(800, 0.25);
  const wav = encodePcm16ToWav(pcm, 16000, 1);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.toString('ascii', 12, 16), 'fmt ');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

test('isLiveApiQuotaOrUnavailableError detects code 1011 quota errors but not invalid key errors', () => {
  assert.equal(
    isLiveApiQuotaOrUnavailableError(
      new Error(
        'Live connection closed before setup completed (code 1011): You exceeded your current quota, please check your plan and billing details.'
      )
    ),
    true
  );
  assert.equal(
    isLiveApiQuotaOrUnavailableError(new Error('RESOURCE_EXHAUSTED: 429 Too Many Requests')),
    true
  );
  assert.equal(
    isLiveApiQuotaOrUnavailableError(new Error('API key not valid. Please pass a valid API key.')),
    false
  );
  assert.equal(
    isLiveApiQuotaOrUnavailableError(new Error('GEMINI_API_KEY is not configured.')),
    false
  );
});

test('UtteranceVadAccumulator captures pre-roll + speech and flushes after trailing silence', () => {
  const vad = new UtteranceVadAccumulator({
    sampleRate: 16000,
    speechThresholdRms: 0.02,
    silenceFlushMs: 500,
    minSpeechMs: 250,
  });

  const silence = makePcmChunk(4096, 0.001); // ~256ms
  const speech = makePcmChunk(4096, 0.2); // ~256ms

  // Initial silence should not trigger speech
  assert.equal(vad.pushChunk(silence), null);
  // Speech onset captures preRoll + speech
  assert.equal(vad.pushChunk(speech), null);
  assert.equal(vad.pushChunk(speech), null);
  // Trailing silence (<500ms) keeps buffering
  assert.equal(vad.pushChunk(silence), null);
  // Second silence (>500ms) flushes complete utterance (1 preRoll + 2 speech + 2 silence = 5 chunks)
  const flushed = vad.pushChunk(silence);
  assert.ok(flushed !== null);
  assert.equal(flushed.length, 5 * 4096 * 2);
});

test('mapLanguageToBcp47 maps supported languages accurately', () => {
  assert.equal(mapLanguageToBcp47('Hindi'), 'hi-IN');
  assert.equal(mapLanguageToBcp47('English'), 'en-US');
  assert.equal(mapLanguageToBcp47('Spanish'), 'es-ES');
  assert.equal(mapLanguageToBcp47(null), 'en-US');
});

test('classifyMicrophoneError maps Permission denied and missing device to Speaker Mode notice', () => {
  const denied = classifyMicrophoneError(new Error('Permission denied'));
  assert.equal(denied.isPermissionOrMissing, true);
  assert.ok(denied.notice.includes('Speaker Mode'));

  const missing = classifyMicrophoneError(new Error('Requested device not found'));
  assert.equal(missing.isPermissionOrMissing, true);
  assert.ok(missing.notice.toLowerCase().includes('no microphone'));
});
