'use client';

import { useEffect, useRef } from 'react';
import { ArrowRight } from 'lucide-react';
import { gsap } from '@/lib/gsap';
import { LandingButton } from './LandingButton';

export function CTASection() {
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!sectionRef.current) return;
    const section = sectionRef.current;
    const prefersReduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    if (prefersReduced) return;

    const ctaCard = section.querySelector<HTMLElement>('[data-cta-card]');
    if (!ctaCard) return;

    gsap.set(ctaCard, { opacity: 0, y: 30 });

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          gsap.to(ctaCard, {
            opacity: 1,
            y: 0,
            duration: 0.7,
            ease: 'power3.out',
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

        <h2 className="animate-float text-2xl font-bold tracking-tight sm:text-3xl">
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
        </div>
      </div>
    </section>
  );
}
