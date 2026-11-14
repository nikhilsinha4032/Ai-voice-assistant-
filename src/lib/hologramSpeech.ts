export interface HologramSpeechFrame {
  jawOpen: number;
  headNod: number;
  headTurn: number;
  pulse: number;
  barHeights: [number, number, number, number, number, number, number];
}

export function estimateSpeechDurationMs(text: string): number {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (words === 0) return 0;
  // ~190 words per minute pacing, bounded cleanly for dashboard feedback
  const ms = Math.round((words / 3.1) * 1000);
  return Math.min(7500, Math.max(2400, ms));
}

export function computeSpeechEnvelope(
  timeSec: number,
  isSpeaking: boolean,
  isThinking: boolean,
  externalAmplitude: number
): HologramSpeechFrame {
  const clampedAmp = Math.min(1, Math.max(0, Number.isFinite(externalAmplitude) ? externalAmplitude : 0));

  if (!isSpeaking) {
    const idleBreath = 0.08 + 0.05 * Math.sin(timeSec * 1.9);
    const thinkPulse = isThinking ? 0.35 + 0.2 * Math.sin(timeSec * 4.5) : idleBreath;
    const idleBar = isThinking ? 0.24 + 0.14 * Math.sin(timeSec * 5.2) : 0.14;
    return {
      jawOpen: 0,
      headNod: isThinking ? Math.sin(timeSec * 2.1) * 0.05 : Math.sin(timeSec * 1.1) * 0.025,
      headTurn: isThinking ? Math.sin(timeSec * 1.7) * 0.18 : Math.sin(timeSec * 0.7) * 0.08,
      pulse: thinkPulse,
      barHeights: [
        idleBar * 0.7,
        idleBar * 0.85,
        idleBar,
        idleBar * 1.1,
        idleBar,
        idleBar * 0.85,
        idleBar * 0.7,
      ],
    };
  }

  // Natural syllable cadence with brief inter-word micro-dips
  const syllableWave =
    0.52 +
    0.28 * Math.sin(timeSec * 13.5) +
    0.14 * Math.sin(timeSec * 21.3 + 0.8) +
    0.06 * Math.cos(timeSec * 7.1);
  const phrasePause = 0.65 + 0.35 * Math.sin(timeSec * 3.4);
  const liveDrive = clampedAmp > 0.03 ? Math.min(1, 0.35 + clampedAmp * 1.85) : 0.78;

  const jawOpen = Math.min(1, Math.max(0.12, syllableWave * phrasePause * liveDrive));
  const pulse = Math.min(1, 0.55 + jawOpen * 0.45);
  const headNod = Math.sin(timeSec * 4.6) * 0.065 * liveDrive;
  const headTurn = Math.sin(timeSec * 1.9) * 0.12;

  const b0 = Math.min(1, Math.max(0.15, jawOpen * (0.45 + 0.25 * Math.sin(timeSec * 16 + 0.0))));
  const b1 = Math.min(1, Math.max(0.18, jawOpen * (0.68 + 0.28 * Math.sin(timeSec * 19 + 0.7))));
  const b2 = Math.min(1, Math.max(0.22, jawOpen * (0.88 + 0.24 * Math.sin(timeSec * 23 + 1.4))));
  const b3 = Math.min(1, Math.max(0.28, jawOpen * (1.0 + 0.22 * Math.sin(timeSec * 26 + 2.1))));
  const b4 = Math.min(1, Math.max(0.22, jawOpen * (0.88 + 0.24 * Math.sin(timeSec * 22 + 2.8))));
  const b5 = Math.min(1, Math.max(0.18, jawOpen * (0.68 + 0.28 * Math.sin(timeSec * 18 + 3.5))));
  const b6 = Math.min(1, Math.max(0.15, jawOpen * (0.45 + 0.25 * Math.sin(timeSec * 15 + 4.2))));

  return {
    jawOpen,
    headNod,
    headTurn,
    pulse,
    barHeights: [b0, b1, b2, b3, b4, b5, b6],
  };
}
