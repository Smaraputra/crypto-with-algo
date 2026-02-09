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
      className="relative py-16 sm:py-24"
    >
      {/* Pattern background */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.03]"
        aria-hidden="true"
        style={{
          backgroundImage:
            'radial-gradient(circle, oklch(1 0 0 / 0.4) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />

      {/* Gradient glow */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            'radial-gradient(ellipse 600px 300px at 50% 50%, oklch(0.72 0.18 160 / 0.06), transparent)',
        }}
      />

      <div className="relative mx-auto max-w-3xl px-4 text-center" data-cta-card>
        <div className="gradient-separator mb-12" />

        <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
          <span className="gradient-heading">Start Tracking Today</span>
        </h2>
        <p className="mt-3 text-muted-foreground">
          Create your free account and connect to live market data in seconds.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
          <LandingButton variant="solid" size="lg" href="/register">
            Create Free Account
            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
          </LandingButton>
          <a
            href="#features"
            className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Learn More &rarr;
          </a>
        </div>
      </div>
    </section>
  );
}
