'use client';

import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap, ScrollTrigger } from '@/lib/gsap';

const STATS = [
  { value: 99.9, suffix: '%', label: 'Uptime', decimals: 1 },
  { value: 50, suffix: 'ms', label: 'Latency', decimals: 0 },
  { value: 10, suffix: 'K+', label: 'Active Users', decimals: 0 },
  { value: 24, suffix: '/7', label: 'Monitoring', decimals: 0 },
];

export function StatsSection() {
  const sectionRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (!sectionRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      const counters =
        sectionRef.current.querySelectorAll<HTMLElement>('[data-counter]');

      counters.forEach((el) => {
        const target = parseFloat(el.dataset.target || '0');
        const decimals = parseInt(el.dataset.decimals || '0', 10);
        const suffix = el.dataset.suffix || '';

        if (prefersReduced) {
          el.textContent = target.toFixed(decimals) + suffix;
          return;
        }

        const obj = { val: 0 };
        gsap.to(obj, {
          val: target,
          duration: 1.5,
          ease: 'power2.out',
          scrollTrigger: {
            trigger: el,
            start: 'top 85%',
            once: true,
          },
          onUpdate: () => {
            el.textContent = obj.val.toFixed(decimals) + suffix;
          },
        });
      });

      return () => {
        ScrollTrigger.getAll().forEach((t) => t.kill());
      };
    },
    { scope: sectionRef }
  );

  return (
    <section
      ref={sectionRef}
      className="border-t border-border bg-card/30 py-16 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4">
        <div
          className="grid grid-cols-2 gap-8 sm:grid-cols-4"
          data-testid="stats-grid"
        >
          {STATS.map((stat) => (
            <div key={stat.label} className="text-center">
              <div
                className="font-mono text-3xl font-bold tabular-nums text-accent sm:text-4xl"
                data-counter
                data-target={stat.value}
                data-decimals={stat.decimals}
                data-suffix={stat.suffix}
                aria-label={`${stat.value}${stat.suffix} ${stat.label}`}
              >
                0{stat.suffix}
              </div>
              <div className="mt-2 text-sm text-muted-foreground">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
