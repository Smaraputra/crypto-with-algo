'use client';

import { useRef } from 'react';
import { Lock, SlidersHorizontal, Zap } from 'lucide-react';
import { useGSAP } from '@gsap/react';
import { gsap, ScrollTrigger } from '@/lib/gsap';

const STEPS = [
  {
    number: 1,
    icon: Lock,
    title: 'Connect',
    description: 'Link your exchange API keys securely with read-only access.',
  },
  {
    number: 2,
    icon: SlidersHorizontal,
    title: 'Configure',
    description:
      'Set risk parameters, alert thresholds, and portfolio targets.',
  },
  {
    number: 3,
    icon: Zap,
    title: 'Automate',
    description:
      'Let AlgoCrypto analyze markets and alert you in real time.',
  },
];

export function HowItWorksSection() {
  const sectionRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (!sectionRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      if (prefersReduced) {
        gsap.set('[data-step-card]', { opacity: 1, y: 0 });
        gsap.set('[data-connector]', { scaleX: 1 });
        return;
      }

      gsap.from('[data-step-card]', {
        opacity: 0,
        y: 40,
        duration: 0.6,
        stagger: 0.2,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top 75%',
          once: true,
        },
      });

      gsap.from('[data-connector]', {
        scaleX: 0,
        duration: 0.8,
        stagger: 0.3,
        delay: 0.4,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top 75%',
          once: true,
        },
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
      className="border-t border-border py-16 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
          How It Works
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
          Get started in three simple steps.
        </p>

        <div className="mt-12 grid gap-8 sm:grid-cols-3" data-testid="how-it-works-grid">
          {STEPS.map((step, i) => (
            <div key={step.title} className="relative flex flex-col items-center text-center">
              {/* Connector line between steps (hidden on mobile, visible sm+) */}
              {i < STEPS.length - 1 && (
                <div
                  data-connector
                  className="absolute top-8 left-[calc(50%+2rem)] hidden h-px w-[calc(100%-4rem)] origin-left bg-accent/30 sm:block"
                  aria-hidden="true"
                />
              )}

              <div
                data-step-card
                className="flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-accent/30 bg-accent/5">
                  <step.icon className="h-7 w-7 text-accent" />
                </div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">
                  Step {step.number}
                </div>
                <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>
                <p className="mt-2 max-w-xs text-sm text-muted-foreground">
                  {step.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
