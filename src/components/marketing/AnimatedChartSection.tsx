'use client';

import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap, ScrollTrigger } from '@/lib/gsap';

const CHART_PATH =
  'M 0 180 C 40 170, 80 160, 120 150 C 160 140, 200 155, 240 130 C 280 105, 320 120, 360 95 C 400 70, 440 85, 480 60 C 520 35, 560 50, 600 25';

const DATA_POINTS = [
  { x: 0, y: 180, label: '$61,200' },
  { x: 120, y: 150, label: '$63,400' },
  { x: 240, y: 130, label: '$64,800' },
  { x: 360, y: 95, label: '$67,100' },
  { x: 480, y: 60, label: '$69,500' },
  { x: 600, y: 25, label: '$72,300' },
];

const GRID_LINES_Y = [40, 80, 120, 160];
const GRID_LINES_X = [120, 240, 360, 480];

export function AnimatedChartSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useGSAP(
    () => {
      if (!sectionRef.current || !pathRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      const path = pathRef.current;
      const length = path.getTotalLength();

      if (prefersReduced) {
        gsap.set(path, { strokeDasharray: 'none', strokeDashoffset: 0 });
        gsap.set('[data-chart-point]', { opacity: 1, scale: 1 });
        gsap.set('[data-chart-label]', { opacity: 1 });
        gsap.set('[data-chart-fill]', { opacity: 1 });
        return;
      }

      gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top 75%',
          once: true,
        },
      });

      // Draw the line
      tl.to(path, {
        strokeDashoffset: 0,
        duration: 1.5,
        ease: 'power2.out',
      });

      // Fade in fill area
      tl.to(
        '[data-chart-fill]',
        { opacity: 1, duration: 0.8, ease: 'power2.out' },
        '-=0.8'
      );

      // Data points pop in
      tl.from(
        '[data-chart-point]',
        {
          scale: 0,
          opacity: 0,
          duration: 0.4,
          stagger: 0.08,
          ease: 'back.out(2)',
        },
        '-=0.4'
      );

      // Labels fade in
      tl.from(
        '[data-chart-label]',
        {
          opacity: 0,
          y: 5,
          duration: 0.3,
          stagger: 0.06,
        },
        '-=0.3'
      );

      return () => {
        ScrollTrigger.getAll().forEach((t) => t.kill());
      };
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="border-t border-border py-16 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Real-Time Market Intelligence
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
          Track price movements with professional-grade charting and instant
          data feeds.
        </p>

        <div
          className="mx-auto mt-10 max-w-2xl rounded-xl border border-border bg-card p-6"
          data-testid="animated-chart"
          style={{
            backgroundImage:
              'radial-gradient(circle, oklch(1 0 0 / 0.03) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
          }}
        >
          <svg
            viewBox="0 0 600 200"
            className="h-auto w-full"
            role="img"
            aria-label="Animated price chart showing upward trend"
          >
            {/* Grid lines */}
            {GRID_LINES_Y.map((y) => (
              <line
                key={`h-${y}`}
                x1="0"
                y1={y}
                x2="600"
                y2={y}
                stroke="currentColor"
                strokeOpacity={0.06}
                strokeDasharray="4 4"
              />
            ))}
            {GRID_LINES_X.map((x) => (
              <line
                key={`v-${x}`}
                x1={x}
                y1="0"
                x2={x}
                y2="200"
                stroke="currentColor"
                strokeOpacity={0.06}
                strokeDasharray="4 4"
              />
            ))}

            {/* Gradient fill under curve */}
            <defs>
              <linearGradient
                id="chart-gradient"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor="#0ecb81" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#0ecb81" stopOpacity={0} />
              </linearGradient>
              <filter id="chart-glow">
                <feGaussianBlur stdDeviation="3" result="glow" />
                <feMerge>
                  <feMergeNode in="glow" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Filled area */}
            <path
              d={`${CHART_PATH} L 600 200 L 0 200 Z`}
              fill="url(#chart-gradient)"
              opacity={0}
              data-chart-fill
            />

            {/* Animated line with glow */}
            <path
              ref={pathRef}
              d={CHART_PATH}
              fill="none"
              stroke="#0ecb81"
              strokeWidth={2.5}
              strokeLinecap="round"
              filter="url(#chart-glow)"
            />

            {/* Data points */}
            {DATA_POINTS.map((pt) => (
              <circle
                key={`pt-${pt.x}`}
                cx={pt.x}
                cy={pt.y}
                r={4}
                fill="#0ecb81"
                stroke="#1e2329"
                strokeWidth={2}
                data-chart-point
              />
            ))}

            {/* Price labels */}
            {DATA_POINTS.map((pt) => (
              <text
                key={`lbl-${pt.x}`}
                x={pt.x}
                y={pt.y - 12}
                textAnchor="middle"
                fill="#0ecb81"
                fontSize={10}
                fontFamily="monospace"
                data-chart-label
              >
                {pt.label}
              </text>
            ))}
          </svg>
        </div>
      </div>
    </section>
  );
}
