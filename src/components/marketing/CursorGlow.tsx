'use client';

import { useEffect, useRef, useState } from 'react';

export function CursorGlow() {
  const glowRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Skip on touch devices (mobile, tablet)
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isTouchDevice) return;

    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;
    const hasHover = window.matchMedia('(hover: hover)').matches;

    if (prefersReduced || !hasHover) return;

    const glow = glowRef.current;
    if (!glow) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!visible) setVisible(true);
      glow.style.transform = `translate(${e.clientX - 200}px, ${e.clientY - 200}px)`;
    };

    const handlePointerLeave = () => {
      setVisible(false);
    };

    document.addEventListener('pointermove', handlePointerMove, {
      passive: true,
    });
    document.addEventListener('pointerleave', handlePointerLeave);

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handlePointerLeave);
    };
  }, [visible]);

  return (
    <div
      ref={glowRef}
      data-testid="cursor-glow"
      className="pointer-events-none fixed top-0 left-0 z-[1] h-[400px] w-[400px] rounded-full opacity-0 transition-opacity duration-300"
      style={{
        background:
          'radial-gradient(circle, oklch(0.72 0.18 160 / 0.06), transparent 70%)',
        opacity: visible ? 1 : 0,
      }}
      aria-hidden="true"
    />
  );
}
