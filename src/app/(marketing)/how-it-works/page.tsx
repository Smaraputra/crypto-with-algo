import {
  UserPlus,
  SlidersHorizontal,
  Zap,
  Briefcase,
  Eye,
  Bell,
  BarChart3,
  Brain,
  CheckCircle2,
} from 'lucide-react';
import { ContentLayout } from '@/components/marketing/ContentLayout';

const STEPS = [
  {
    number: 1,
    icon: UserPlus,
    title: 'Sign Up',
    subtitle: 'Create your free account',
    description:
      'Register with your email and password in seconds. No credit card needed. All core features are free from day one.',
    details: [
      {
        icon: UserPlus,
        text: 'Register with email - no credit card required',
      },
      {
        icon: Eye,
        text: 'Instant access to live market data from Binance',
      },
      {
        icon: Briefcase,
        text: 'Create your first portfolio right away',
      },
    ],
  },
  {
    number: 2,
    icon: SlidersHorizontal,
    title: 'Track',
    subtitle: 'Build your portfolio and watchlist',
    description:
      'Create portfolios, add holdings with cost basis, and build a watchlist of symbols you care about. Set price alerts so you never miss a move.',
    details: [
      {
        icon: BarChart3,
        text: 'Create portfolios and add crypto holdings',
      },
      {
        icon: Bell,
        text: 'Configure price and portfolio alerts',
      },
      {
        icon: Brain,
        text: 'Select technical indicators for signal analysis',
      },
    ],
  },
  {
    number: 3,
    icon: Zap,
    title: 'Analyze',
    subtitle: 'Signals, backtesting, and real-time alerts',
    description:
      'CryptoWithAlgo continuously monitors markets via WebSocket feeds. Review trading signals powered by RSI, MACD, and more. Backtest strategies against historical data before committing capital.',
    details: [
      {
        icon: Zap,
        text: 'Real-time WebSocket price monitoring 24/7',
      },
      {
        icon: Bell,
        text: 'Automated alert evaluation every minute',
      },
      {
        icon: CheckCircle2,
        text: 'Backtest strategies with historical Binance data',
      },
    ],
  },
];

export default function HowItWorksPage() {
  return (
    <ContentLayout
      title="How It Works"
      subtitle="Get started in three simple steps. Free to use, no credit card needed."
    >
      <div className="space-y-12">
        {STEPS.map((step, i) => (
          <section
            key={step.title}
            className="rounded-xl border border-border/50 bg-card p-6 sm:p-8"
          >
            <div className="flex items-start gap-4 sm:gap-6">
              {/* Step number + icon */}
              <div className="shrink-0">
                <div className="flex h-14 w-14 items-center justify-center rounded-full border border-primary/30 bg-primary/5">
                  <step.icon className="h-6 w-6 text-primary" />
                </div>
                <div className="mt-1 text-center font-mono text-xs text-muted-foreground">
                  Step {step.number}
                </div>
              </div>

              {/* Content */}
              <div className="flex-1">
                <h2 className="text-xl font-bold">{step.title}</h2>
                <p className="text-sm text-muted-foreground">{step.subtitle}</p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {step.description}
                </p>

                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  {step.details.map((detail) => (
                    <div
                      key={detail.text}
                      className="flex items-start gap-2 rounded-lg border border-border/30 bg-background/50 p-3"
                    >
                      <detail.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="text-xs text-muted-foreground">
                        {detail.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Connector */}
            {i < STEPS.length - 1 && (
              <div className="ml-7 mt-6 flex justify-start" aria-hidden="true">
                <div className="h-6 w-px bg-gradient-to-b from-primary/40 to-transparent" />
              </div>
            )}
          </section>
        ))}
      </div>

      {/* CTA */}
      <div className="mt-12 text-center">
        <p className="text-muted-foreground">
          Ready to get started? Create your free account in seconds.
        </p>
        <a
          href="/register"
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Create Free Account
        </a>
      </div>
    </ContentLayout>
  );
}
