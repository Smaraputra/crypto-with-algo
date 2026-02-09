'use client';

import { useRef } from 'react';
import { LazyMotion, domAnimation, motion, useInView } from 'framer-motion';

const CHART_PATH =
  'M 0 180 C 40 170, 80 160, 120 150 C 160 140, 200 155, 240 130 C 280 105, 320 120, 360 95 C 400 70, 440 85, 480 60 C 520 35, 560 50, 600 25';

const GRID_LINES_Y = [40, 80, 120, 160];
const GRID_LINES_X = [120, 240, 360, 480];

export function AnimatedChartSection() {
  const sectionRef = useRef<HTMLElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.3 });

  return (
    <LazyMotion features={domAnimation}>
      <section
        ref={sectionRef}
        className="border-t border-border py-16 sm:py-24"
      >
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
            Real-Time Market Intelligence
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
            Track price movements with professional-grade charting and instant data feeds.
          </p>

          <div
            className="mx-auto mt-10 max-w-2xl rounded-xl border border-border bg-card p-6"
            data-testid="animated-chart"
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
              </defs>

              {/* Filled area */}
              <motion.path
                d={`${CHART_PATH} L 600 200 L 0 200 Z`}
                fill="url(#chart-gradient)"
                initial={{ opacity: 0 }}
                animate={isInView ? { opacity: 1 } : { opacity: 0 }}
                transition={{ duration: 1, delay: 0.5 }}
              />

              {/* Animated line */}
              <motion.path
                d={CHART_PATH}
                fill="none"
                stroke="#0ecb81"
                strokeWidth={2.5}
                strokeLinecap="round"
                initial={{ pathLength: 0 }}
                animate={isInView ? { pathLength: 1 } : { pathLength: 0 }}
                transition={{ duration: 1.5, ease: 'easeOut' }}
              />
            </svg>
          </div>
        </div>
      </section>
    </LazyMotion>
  );
}
