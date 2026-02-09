'use client';

import { useRef } from 'react';
import {
  Briefcase,
  TrendingUp,
  Bell,
  BarChart3,
  CandlestickChart,
  Download,
} from 'lucide-react';
import { LazyMotion, domAnimation, motion, useInView } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';

const FEATURES = [
  {
    icon: Briefcase,
    title: 'Portfolio Management',
    description:
      'Track holdings across multiple portfolios with real-time valuations and P&L.',
  },
  {
    icon: TrendingUp,
    title: 'Live Market Data',
    description:
      'WebSocket-powered price feeds from Binance with sub-second updates.',
  },
  {
    icon: Bell,
    title: 'Smart Alerts',
    description:
      'Set price, portfolio value, and percentage-change alerts with recurring options.',
  },
  {
    icon: BarChart3,
    title: 'Analytics Dashboard',
    description:
      'Portfolio history charts, risk metrics, Sharpe ratio, and drawdown analysis.',
  },
  {
    icon: CandlestickChart,
    title: 'Interactive Charts',
    description:
      'Professional candlestick charts with MA, EMA, BOLL, and volume overlays.',
  },
  {
    icon: Download,
    title: 'Tax Export',
    description:
      'FIFO/LIFO/HIFO cost basis with Generic, Koinly, and CoinTracker CSV exports.',
  },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.1 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: 'easeOut' as const },
  },
};

export function FeaturesSection() {
  const sectionRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(sectionRef, { once: true, amount: 0.2 });

  return (
    <LazyMotion features={domAnimation}>
      <section className="border-t border-border bg-card/30 py-16 sm:py-24">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
            Everything You Need
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
            Professional-grade tools for managing your cryptocurrency portfolio.
          </p>

          <motion.div
            ref={sectionRef}
            className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="features-grid"
            variants={containerVariants}
            initial="hidden"
            animate={isInView ? 'visible' : 'hidden'}
          >
            {FEATURES.map((feature) => (
              <motion.div key={feature.title} variants={cardVariants}>
                <Card className="border-border/50">
                  <CardContent className="pt-6">
                    <feature.icon className="mb-3 h-8 w-8 text-primary" />
                    <h3 className="text-sm font-semibold">{feature.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {feature.description}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>
    </LazyMotion>
  );
}
