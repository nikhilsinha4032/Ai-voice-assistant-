import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRmsAmplitude,
  int16BytesToFloat32,
  resampleFloat32,
} from './audio';

test('int16BytesToFloat32 safely handles odd byte lengths without throwing', () => {
  // 5 bytes = 2 full Int16 samples + 1 trailing orphan byte
  const oddBytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0x7f]);
  const out = int16BytesToFloat32(oddBytes);
  assert.equal(out.length, 2);
  assert.ok(out[0] > 0.49 && out[0] < 0.51);
  assert.ok(out[1] < -0.49 && out[1] > -0.51);

  assert.equal(int16BytesToFloat32(new Uint8Array([0x01])).length, 0);
});

test('resampleFloat32 converts 48kHz buffers down to 16kHz preserving length ratio and amplitude', () => {
  const input48k = new Float32Array(4800);
  for (let i = 0; i < input48k.length; i++) {
    input48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
  }
  const output16k = resampleFloat32(input48k, 48000, 16000);
  assert.equal(output16k.length, 1600);
  const rmsIn = computeRmsAmplitude(input48k);
  const rmsOut = computeRmsAmplitude(output16k);
  assert.ok(Math.abs(rmsIn - rmsOut) < 0.05);
});
