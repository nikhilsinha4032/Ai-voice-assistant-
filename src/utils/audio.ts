export function float32ToInt16Base64(float32: Float32Array): string {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function resampleFloat32(
  samples: Float32Array,
  inputRate: number,
  targetRate = 16000
): Float32Array {
  if (inputRate <= 0 || targetRate <= 0 || inputRate === targetRate || samples.length === 0) {
    return samples;
  }
  const ratio = inputRate / targetRate;
  const outputLength = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(samples.length - 1, low + 1);
    const frac = srcIndex - low;
    output[i] = samples[low] * (1 - frac) + samples[high] * frac;
  }
  return output;
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function int16BytesToFloat32(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.length / 2);
  if (sampleCount === 0) return new Float32Array(0);
  const aligned =
    bytes.byteOffset % 2 === 0
      ? new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount)
      : new Int16Array(bytes.slice(0, sampleCount * 2).buffer);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = aligned[i] / 0x8000;
  }
  return float32;
}

export function base64Int16ToFloat32(base64: string): Float32Array {
  return int16BytesToFloat32(base64ToUint8Array(base64));
}

export function computeRmsAmplitude(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSq += samples[i] * samples[i];
  }
  return Math.min(1, Math.sqrt(sumSq / samples.length) * 3.5);
}

export function createAudioContextSafe(preferredSampleRate: number): AudioContext {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  try {
    return new AudioCtx({ sampleRate: preferredSampleRate });
  } catch {
    return new AudioCtx();
  }
}

export async function requestMicrophoneStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new Error('mediaDevices unavailable');
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (firstErr) {
    const name = firstErr instanceof Error ? firstErr.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw firstErr;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (secondErr) {
      const secondName = secondErr instanceof Error ? secondErr.name : '';
      if (secondName === 'NotAllowedError' || secondName === 'SecurityError') {
        throw secondErr;
      }
      if (typeof navigator.mediaDevices.enumerateDevices === 'function') {
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        const audioInput = devices.find((d) => d.kind === 'audioinput' && d.deviceId);
        if (audioInput) {
          return await navigator.mediaDevices.getUserMedia({
            audio: { deviceId: { ideal: audioInput.deviceId } },
          });
        }
      }
      throw secondErr;
    }
  }
}

export class AudioPlaybackScheduler {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Float32Array<ArrayBuffer> | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();

  public ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = createAudioContextSafe(24000);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyserData = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => undefined);
    }
  }

  public getLiveAmplitude(): number {
    if (!this.analyser || !this.analyserData || this.activeSources.size === 0) {
      return 0;
    }
    this.analyser.getFloatTimeDomainData(this.analyserData);
    return computeRmsAmplitude(this.analyserData);
  }

  public isPlaying(): boolean {
    return this.activeSources.size > 0;
  }

  private scheduleBuffer(buffer: AudioBuffer, onEnd?: () => void): void {
    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (this.analyser) {
      source.connect(this.analyser);
    } else {
      source.connect(ctx.destination);
    }

    const now = ctx.currentTime;
    if (this.nextStartTime < now) {
      this.nextStartTime = now + 0.015;
    }

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (this.activeSources.size === 0 && onEnd) {
        onEnd();
      }
    };
    source.start(this.nextStartTime);
    this.nextStartTime += buffer.duration;
  }

  public enqueuePcm24k(base64Audio: string, onEnd?: () => void): number {
    const ctx = this.ensureContext();
    const float32 = base64Int16ToFloat32(base64Audio);
    if (float32.length === 0) {
      if (this.activeSources.size === 0 && onEnd) onEnd();
      return 0;
    }
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(new Float32Array(float32), 0);
    this.scheduleBuffer(buffer, onEnd);
    return computeRmsAmplitude(float32);
  }

  public async enqueuePcm24kBatch(chunks: string[], onEnd?: () => void): Promise<number> {
    await this.unlock();
    const decodedParts: Uint8Array[] = [];
    let totalBytes = 0;
    for (const chunk of chunks) {
      if (!chunk) continue;
      const bytes = base64ToUint8Array(chunk);
      if (bytes.length > 0) {
        decodedParts.push(bytes);
        totalBytes += bytes.length;
      }
    }
    if (totalBytes < 2) {
      if (this.activeSources.size === 0 && onEnd) onEnd();
      return 0;
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of decodedParts) {
      combined.set(part, offset);
      offset += part.length;
    }

    const float32 = int16BytesToFloat32(combined);
    if (float32.length === 0) {
      if (this.activeSources.size === 0 && onEnd) onEnd();
      return 0;
    }

    const ctx = this.ensureContext();
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(new Float32Array(float32), 0);
    this.scheduleBuffer(buffer, onEnd);
    return computeRmsAmplitude(float32);
  }

  public async playWavBase64(wavBase64: string, onEnd?: () => void): Promise<boolean> {
    try {
      await this.unlock();
      const ctx = this.ensureContext();
      const bytes = base64ToUint8Array(wavBase64);
      const bufferCopy = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      const audioBuffer = await ctx.decodeAudioData(bufferCopy);
      this.scheduleBuffer(audioBuffer, onEnd);
      return true;
    } catch {
      return false;
    }
  }

  public interrupt(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // Ignore already stopped sources
      }
    }
    this.activeSources.clear();
    if (this.ctx) {
      this.nextStartTime = this.ctx.currentTime;
    }
  }

  public async close(): Promise<void> {
    this.interrupt();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.analyser = null;
      this.analyserData = null;
    }
  }
}
