/**
 * Pure audio framing, RMS VAD, and WAV encoding utilities for the quota-resilient
 * turn-based Voice Bridge fallback on /api/live-voice.
 */

export function computeInt16PcmRms(pcmBuffer: Buffer): number {
  const sampleCount = Math.floor(pcmBuffer.length / 2);
  if (sampleCount === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 2) / 32768;
    sumSq += sample * sample;
  }
  return Math.sqrt(sumSq / sampleCount);
}

export function encodePcm16ToWav(
  pcmBuffer: Buffer,
  sampleRate = 16000,
  channels = 1
): Buffer {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // Linear PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

export function isLiveApiQuotaOrUnavailableError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const lower = raw.toLowerCase();

  // Do not treat missing or invalid API key errors as quota failover
  if (
    lower.includes('api key not valid') ||
    lower.includes('api_key_invalid') ||
    lower.includes('is not configured')
  ) {
    return false;
  }

  return (
    lower.includes('code 1011') ||
    lower.includes('exceeded your current quota') ||
    lower.includes('quota') ||
    lower.includes('billing') ||
    lower.includes('resource_exhausted') ||
    lower.includes('429') ||
    lower.includes('404') ||
    lower.includes('unexpected server response') ||
    lower.includes('before setup completed') ||
    lower.includes('unavailable')
  );
}

export function mapLanguageToBcp47(language?: string | null): string {
  const key = (language || '').trim().toLowerCase();
  const map: Record<string, string> = {
    english: 'en-US',
    hindi: 'hi-IN',
    hinglish: 'hi-IN',
    spanish: 'es-ES',
    french: 'fr-FR',
    german: 'de-DE',
    marathi: 'mr-IN',
    tamil: 'ta-IN',
    telugu: 'te-IN',
    bengali: 'bn-IN',
    arabic: 'ar-SA',
    portuguese: 'pt-BR',
    japanese: 'ja-JP',
  };
  return map[key] || 'en-US';
}

export function classifyMicrophoneError(err: unknown): {
  isPermissionOrMissing: boolean;
  notice: string;
} {
  const raw = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
  const lower = raw.toLowerCase();

  if (
    lower.includes('notallowed') ||
    lower.includes('permission denied') ||
    lower.includes('permission dismissed') ||
    lower.includes('securityerror')
  ) {
    return {
      isPermissionOrMissing: true,
      notice:
        'Live Voice Speaker Mode active (microphone blocked in this frame or browser). Allow Microphone in site settings or open in a full browser tab and click Retry Mic — or send any message/scenario below for spoken AI replies.',
    };
  }

  if (
    lower.includes('notfound') ||
    lower.includes('requested device not found') ||
    lower.includes('no audio') ||
    lower.includes('mediadevices') ||
    lower.includes('unavailable')
  ) {
    return {
      isPermissionOrMissing: true,
      notice:
        'Live Voice Speaker Mode active (no microphone detected). Send any message or scenario below to hear spoken AI replies with 3D hologram lip-sync.',
    };
  }

  return {
    isPermissionOrMissing: false,
    notice:
      'Live Voice Speaker Mode active (microphone unavailable). Send any message or scenario below for spoken AI replies.',
  };
}

export interface VadOptions {
  sampleRate?: number;
  speechThresholdRms?: number;
  silenceFlushMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
}

export class UtteranceVadAccumulator {
  private readonly sampleRate: number;
  private readonly speechThresholdRms: number;
  private readonly silenceFlushMs: number;
  private readonly minSpeechMs: number;
  private readonly maxUtteranceMs: number;

  private inSpeech = false;
  private preRoll: Buffer | null = null;
  private chunks: Buffer[] = [];
  private speechDurationMs = 0;
  private silenceDurationMs = 0;
  private totalDurationMs = 0;

  constructor(options: VadOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.speechThresholdRms = options.speechThresholdRms ?? 0.014;
    this.silenceFlushMs = options.silenceFlushMs ?? 900;
    this.minSpeechMs = options.minSpeechMs ?? 320;
    this.maxUtteranceMs = options.maxUtteranceMs ?? 15000;
  }

  public pushChunk(pcmBuffer: Buffer): Buffer | null {
    if (pcmBuffer.length < 2) return null;
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    const chunkMs = (sampleCount / this.sampleRate) * 1000;
    const rms = computeInt16PcmRms(pcmBuffer);
    const isVoice = rms >= this.speechThresholdRms;

    if (!this.inSpeech) {
      if (isVoice) {
        this.inSpeech = true;
        this.chunks = this.preRoll ? [this.preRoll, pcmBuffer] : [pcmBuffer];
        this.preRoll = null;
        this.speechDurationMs = chunkMs;
        this.silenceDurationMs = 0;
        this.totalDurationMs = chunkMs;
      } else {
        this.preRoll = pcmBuffer;
      }
      return null;
    }

    this.chunks.push(pcmBuffer);
    this.totalDurationMs += chunkMs;
    if (isVoice) {
      this.speechDurationMs += chunkMs;
      this.silenceDurationMs = 0;
    } else {
      this.silenceDurationMs += chunkMs;
    }

    if (
      this.silenceDurationMs >= this.silenceFlushMs ||
      this.totalDurationMs >= this.maxUtteranceMs
    ) {
      return this.flush();
    }

    return null;
  }

  public flush(): Buffer | null {
    if (!this.inSpeech || this.chunks.length === 0) {
      this.reset();
      return null;
    }
    const hadEnoughSpeech = this.speechDurationMs >= this.minSpeechMs;
    const combined = hadEnoughSpeech ? Buffer.concat(this.chunks) : null;
    this.reset();
    return combined;
  }

  public reset(): void {
    this.inSpeech = false;
    this.preRoll = null;
    this.chunks = [];
    this.speechDurationMs = 0;
    this.silenceDurationMs = 0;
    this.totalDurationMs = 0;
  }
}
