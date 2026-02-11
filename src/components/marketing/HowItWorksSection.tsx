'use client';

import { useEffect, useRef } from 'react';
import { Lock, SlidersHorizontal, Zap } from 'lucide-react';
import { gsap } from '@/lib/gsap';
import { SpotlightCard } from './SpotlightCard';

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

  useEffect(() => {
    if (!sectionRef.current) return;
    const section = sectionRef.current;
    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    const stepCards = section.querySelectorAll<HTMLElement>('[data-step-card]');
    const connectors = section.querySelectorAll<HTMLElement>('[data-connector]');

    if (prefersReduced) {
      gsap.set(stepCards, { opacity: 1, y: 0 });
      gsap.set(connectors, { scaleX: 1 });
      return;
    }

    gsap.set(stepCards, { opacity: 0, y: 40 });
    gsap.set(connectors, { scaleX: 0 });

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          gsap.to(stepCards, {
            opacity: 1,
            y: 0,
            duration: 0.6,
            stagger: 0.2,
            ease: 'power3.out',
          });
          gsap.to(connectors, {
            scaleX: 1,
            duration: 0.8,
            stagger: 0.3,
            delay: 0.4,
            ease: 'power2.out',
          });
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(section);

    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      id="how-it-works"
      className="py-16 sm:py-24"
    >
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
          <span className="gradient-heading">How It Works</span>
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
          Get started in three simple steps.
        </p>

        <div className="gradient-separator mx-auto mt-6 max-w-xs" />

        <div className="mt-12 grid gap-8 sm:grid-cols-3" data-testid="how-it-works-grid">
          {STEPS.map((step, i) => (
            <div key={step.title} className="relative flex flex-col items-center text-center">
              {/* Connector line between steps */}
              {i < STEPS.length - 1 && (
                <div
                  data-connector
                  className="animate-connector-pulse absolute top-8 left-[calc(50%+2rem)] hidden h-px w-[calc(100%-4rem)] origin-left sm:block"
                  style={{
                    background: 'linear-gradient(90deg, #0ecb81, transparent)',
                  }}
                  aria-hidden="true"
                />
              )}

              <SpotlightCard className="w-full p-6" data-testid={`step-card-${step.number}`}>
                <div data-step-card className="flex flex-col items-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full border border-primary/30 bg-primary/5">
                    <step.icon className="h-7 w-7 text-primary" />
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    Step {step.number}
                  </div>
                  <h3 className="mt-3 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 max-w-xs text-sm text-muted-foreground">
                    {step.description}
                  </p>
                </div>
              </SpotlightCard>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
