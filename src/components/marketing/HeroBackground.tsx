'use client';

import { useEffect, useRef } from 'react';

const PARTICLE_COUNT = 40;
const PARTICLE_COLOR = '#0ecb81';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
}

function createParticles(width: number, height: number): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    radius: Math.random() * 1.5 + 0.5,
    opacity: Math.random() * 0.3 + 0.1,
  }));
}

export function HeroBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let mouseX = 0;
    let mouseY = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };
    resize();

    const rect = canvas.getBoundingClientRect();
    const particles = createParticles(rect.width, rect.height);

    if (prefersReduced) {
      // Draw static dots once
      ctx.clearRect(0, 0, rect.width, rect.height);
      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `${PARTICLE_COLOR}${Math.round(p.opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.fill();
      }
      return;
    }

    const handlePointerMove = (e: PointerEvent) => {
      mouseX = e.clientX - rect.left;
      mouseY = e.clientY - rect.top;
    };
    document.addEventListener('pointermove', handlePointerMove, {
      passive: true,
    });

    const animate = () => {
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      for (const p of particles) {
        // Subtle mouse parallax
        const dx = mouseX - p.x;
        const dy = mouseY - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const parallax = Math.max(0, 1 - dist / 400) * 0.5;

        p.x += p.vx + dx * parallax * 0.001;
        p.y += p.vy + dy * parallax * 0.001;

        // Wrap around edges
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `${PARTICLE_COLOR}${Math.round(p.opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.fill();
      }

      animId = requestAnimationFrame(animate);
    };
    animate();

    window.addEventListener('resize', resize);

    return () => {
      cancelAnimationFrame(animId);
      document.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {/* Perspective grid */}
      <div
        className="hero-grid absolute inset-0"
        style={{
          perspective: '500px',
        }}
      >
        <div
          className="absolute inset-0 animate-grid-scroll"
          style={{
            transform: 'rotateX(60deg)',
            transformOrigin: 'center top',
            backgroundImage:
              'repeating-linear-gradient(0deg, oklch(0.72 0.18 160 / 0.06) 0px, transparent 1px, transparent 60px), repeating-linear-gradient(90deg, oklch(0.72 0.18 160 / 0.06) 0px, transparent 1px, transparent 60px)',
            backgroundSize: '60px 60px',
            maskImage:
              'linear-gradient(to bottom, transparent 0%, white 20%, white 60%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent 0%, white 20%, white 60%, transparent 100%)',
          }}
        />
      </div>

      {/* Canvas particles */}
      <canvas
        ref={canvasRef}
        data-testid="hero-particles"
        className="absolute inset-0 h-full w-full"
      />

      {/* Radial gradient orbs */}
      <div
        data-orb
        className="absolute top-1/4 left-1/2 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/4 rounded-full opacity-[0.08] blur-[120px]"
        style={{ background: 'radial-gradient(ellipse, #0ecb81, transparent)' }}
      />
      <div
        data-orb
        className="absolute -bottom-32 right-1/4 h-[400px] w-[400px] rounded-full opacity-[0.04] blur-[100px]"
        style={{ background: '#00d4aa' }}
      />
    </div>
  );
}
