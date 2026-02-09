'use client';

import { useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { useGSAP } from '@gsap/react';
import { gsap, ScrollTrigger } from '@/lib/gsap';
import { LandingButton } from './LandingButton';

export function CTASection() {
  const sectionRef = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      if (!sectionRef.current) return;
      const prefersReduced = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches;

      if (prefersReduced) return;

      gsap.from(sectionRef.current.querySelector('[data-cta-card]')!, {
        opacity: 0,
        y: 30,
        duration: 0.7,
        ease: 'power3.out',
        scrollTrigger: {
          trigger: sectionRef.current,
          start: 'top 80%',
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
      <div className="mx-auto max-w-2xl px-4 text-center">
        <div
          data-cta-card
          className="relative overflow-hidden rounded-lg border border-accent/30 p-8 sm:p-12"
          style={{
            backgroundImage:
              'radial-gradient(circle, oklch(1 0 0 / 0.02) 1px, transparent 1px)',
            backgroundSize: '16px 16px',
          }}
        >
          {/* Rotating gradient border glow */}
          <div
            className="pointer-events-none absolute -inset-px -z-10 rounded-lg opacity-30"
            aria-hidden="true"
            style={{
              background:
                'conic-gradient(from 0deg, transparent, #f0b90b, transparent, #0ecb81, transparent)',
              animation: 'spin 6s linear infinite',
            }}
          />
          <div className="absolute inset-[1px] -z-10 rounded-lg bg-background" />

          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Start Tracking Today
          </h2>
          <p className="mt-3 text-muted-foreground">
            Create your free account and connect to live market data in seconds.
          </p>
          <div className="mt-6">
            <LandingButton variant="solid" size="lg" href="/register">
              Create Free Account
              <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
            </LandingButton>
          </div>
        </div>
      </div>
    </section>
  );
}
