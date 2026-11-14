import { useEffect, useRef } from 'react';

interface VoiceWaveformProps {
  isLive: boolean;
  isAgentSpeaking: boolean;
  amplitude: number; // 0 to 1
  sentimentScore: number; // -1 to 1
  variant?: 'dark' | 'light';
}

export function VoiceWaveform({
  isLive,
  isAgentSpeaking,
  amplitude,
  sentimentScore,
  variant = 'dark',
}: VoiceWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef({ isLive, isAgentSpeaking, amplitude, sentimentScore, variant });

  useEffect(() => {
    stateRef.current = { isLive, isAgentSpeaking, amplitude, sentimentScore, variant };
  }, [isLive, isAgentSpeaking, amplitude, sentimentScore, variant]);

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
          variant: mode,
        } = stateRef.current;

        const barCount = 56;
        const gap = 3;
        const barWidth = Math.max(2, (width - gap * (barCount - 1)) / barCount);
        const centerY = height / 2;

        // Subtle center baseline rule
        ctx.strokeStyle =
          mode === 'dark' ? 'rgba(148, 163, 184, 0.16)' : 'rgba(148, 163, 184, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, centerY);
        ctx.lineTo(width, centerY);
        ctx.stroke();

        let topColor = mode === 'dark' ? '#475569' : '#cbd5e1';
        let bottomColor = mode === 'dark' ? '#334155' : '#94a3b8';

        if (speaking) {
          topColor = '#60a5fa';
          bottomColor = '#2563eb';
        } else if (live) {
          if (score <= -0.3) {
            topColor = '#fb7185';
            bottomColor = '#e11d48';
          } else if (score >= 0.4) {
            topColor = '#34d399';
            bottomColor = '#059669';
          } else {
            topColor = '#60a5fa';
            bottomColor = '#2563eb';
          }
        }

        const grad = ctx.createLinearGradient(0, 4, 0, height - 4);
        grad.addColorStop(0, topColor);
        grad.addColorStop(1, bottomColor);
        ctx.fillStyle = grad;

        const effectiveAmp = speaking
          ? Math.max(0.36, amp)
          : live
          ? Math.max(0.14, amp)
          : 0.05;

        for (let i = 0; i < barCount; i++) {
          const norm = i / (barCount - 1);
          const envelope = Math.sin(norm * Math.PI);
          const wave = prefersReducedMotion
            ? 0.55
            : 0.5 + 0.5 * Math.sin(phase + i * 0.38);
          const barHeight = Math.max(
            live || speaking ? 4 : 3,
            (height - 12) * effectiveAmp * envelope * (0.35 + 0.65 * wave)
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
  }, [isLive, isAgentSpeaking, amplitude, sentimentScore, variant]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="voice-waveform"
      aria-label="Live audio acoustic waveform"
      className={
        variant === 'dark'
          ? 'h-16 sm:h-20 w-full rounded-lg bg-slate-900/90 border border-slate-800 px-3'
          : 'h-14 w-full rounded-lg bg-slate-50 border border-slate-200 px-3'
      }
    />
  );
}
