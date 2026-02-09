'use client';

import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap, ScrollTrigger } from '@/lib/gsap';

const CHART_PATH =
  'M 0 120 C 60 115, 100 100, 160 90 C 220 80, 260 95, 320 70 C 380 45, 420 60, 480 35 C 540 10, 580 25, 640 5';

export function HeroBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useGSAP(
    () => {
      if (!containerRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      // Parallax orbs on scroll
      const orbs = containerRef.current.querySelectorAll('[data-orb]');
      if (!prefersReduced) {
        orbs.forEach((orb, i) => {
          gsap.to(orb, {
            y: i % 2 === 0 ? -80 : -40,
            scrollTrigger: {
              trigger: containerRef.current,
              start: 'top top',
              end: 'bottom top',
              scrub: 1,
            },
          });
        });
      }

      // Self-drawing chart line
      if (pathRef.current && !prefersReduced) {
        const length = pathRef.current.getTotalLength();
        gsap.set(pathRef.current, {
          strokeDasharray: length,
          strokeDashoffset: length,
        });
        gsap.to(pathRef.current, {
          strokeDashoffset: 0,
          duration: 2,
          delay: 0.8,
          ease: 'power2.out',
        });
      }

      return () => {
        ScrollTrigger.getAll().forEach((t) => t.kill());
      };
    },
    { scope: containerRef }
  );

  return (
    <div
      ref={containerRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {/* Gradient orbs */}
      <div
        data-orb
        className="absolute -top-40 left-1/4 h-96 w-96 rounded-full opacity-[0.07] blur-[120px]"
        style={{ background: '#0ecb81' }}
      />
      <div
        data-orb
        className="absolute top-20 right-1/5 h-80 w-80 rounded-full opacity-[0.07] blur-[120px]"
        style={{ background: '#f0b90b' }}
      />
      <div
        data-orb
        className="absolute -bottom-20 left-1/3 h-72 w-72 rounded-full opacity-[0.05] blur-[100px]"
        style={{ background: '#f6465d' }}
      />

      {/* Background chart line */}
      <svg
        viewBox="0 0 640 130"
        className="absolute bottom-0 left-0 h-auto w-full opacity-20"
        preserveAspectRatio="none"
      >
        <path
          ref={pathRef}
          d={CHART_PATH}
          fill="none"
          stroke="#f0b90b"
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
