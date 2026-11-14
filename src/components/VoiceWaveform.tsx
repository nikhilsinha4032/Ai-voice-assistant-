import { useEffect, useRef } from 'react';

interface VoiceWaveformProps {
  isLive: boolean;
  isAgentSpeaking: boolean;
  amplitude: number; // 0 to 1
  sentimentScore: number; // -1 to 1
}

export function VoiceWaveform({
  isLive,
  isAgentSpeaking,
  amplitude,
  sentimentScore,
}: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({ isLive, isAgentSpeaking, amplitude, sentimentScore });

  useEffect(() => {
    stateRef.current = { isLive, isAgentSpeaking, amplitude, sentimentScore };
  }, [isLive, isAgentSpeaking, amplitude, sentimentScore]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let phase = 0;
    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width > 0 && height > 0) {
        if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
          canvas.width = Math.floor(width * dpr);
          canvas.height = Math.floor(height * dpr);
        }
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const {
          isLive: live,
          isAgentSpeaking: speaking,
          amplitude: amp,
          sentimentScore: score,
        } = stateRef.current;

        const barCount = 48;
        const gap = 3;
        const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
        const centerY = height / 2;

        // Color reflects active state and sentiment cleanly
        let strokeColor = '#CBD5E1';
        if (speaking) {
          strokeColor = '#2563EB';
        } else if (live) {
          strokeColor = score <= -0.3 ? '#DC2626' : score >= 0.4 ? '#16A34A' : '#2563EB';
        }

        const effectiveAmp = speaking
          ? Math.max(0.32, amp)
          : live
          ? Math.max(0.12, amp)
          : 0.04;

        ctx.fillStyle = strokeColor;
        for (let i = 0; i < barCount; i++) {
          const norm = i / (barCount - 1);
          const envelope = Math.sin(norm * Math.PI);
          const wave = prefersReducedMotion
            ? 0.55
            : 0.5 + 0.5 * Math.sin(phase + i * 0.42);
          const barHeight = Math.max(
            3,
            (height - 10) * effectiveAmp * envelope * (0.35 + 0.65 * wave)
          );
          const x = i * (barWidth + gap);
          const y = centerY - barHeight / 2;
          ctx.beginPath();
          ctx.roundRect(x, y, barWidth, barHeight, 1.5);
          ctx.fill();
        }

        ctx.restore();
      }

      if (!prefersReducedMotion && (stateRef.current.isLive || stateRef.current.isAgentSpeaking)) {
        phase += 0.14;
        rafId = requestAnimationFrame(draw);
      }
    };

    draw();
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isLive, isAgentSpeaking, amplitude, sentimentScore]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="voice-waveform"
      aria-label="Live audio acoustic waveform"
      className="h-12 w-full rounded-md bg-slate-50 border border-slate-200 px-2"
    />
  );
}
