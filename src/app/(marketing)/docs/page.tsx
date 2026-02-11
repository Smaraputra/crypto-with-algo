import {
  Briefcase,
  CandlestickChart,
  Bell,
  BarChart3,
  Brain,
  FlaskConical,
  Rocket,
  Settings,
} from 'lucide-react';
import { ContentLayout } from '@/components/marketing/ContentLayout';

const FEATURES = [
  {
    icon: Briefcase,
    title: 'Portfolio Tracking',
    description:
      'Create multiple portfolios with custom names. Add holdings manually or import from exchanges. Track real-time valuations, cost basis, and unrealized P&L across all your positions.',
  },
  {
    icon: CandlestickChart,
    title: 'Interactive Charts',
    description:
      'Professional candlestick charts powered by KlineCharts with multiple timeframes (1m to 1M). Overlay technical indicators including MA, EMA, Bollinger Bands, and volume analysis.',
  },
  {
    icon: Bell,
    title: 'Smart Alerts',
    description:
      'Configure price alerts with above/below thresholds. Set portfolio value alerts and percentage-change triggers. Alerts can be one-time or recurring with customizable cooldown periods.',
  },
  {
    icon: BarChart3,
    title: 'Analytics Dashboard',
    description:
      'Visualize portfolio history with interactive area charts. Track risk metrics including Sharpe ratio, Sortino ratio, max drawdown, and Value at Risk (VaR). Export data as CSV.',
  },
  {
    icon: Brain,
    title: 'Trading Signals',
    description:
      'Multi-indicator signal engine combining RSI, MACD, Stochastic RSI, and Ichimoku Cloud. Aggregated confidence scores with Strong Buy to Strong Sell ratings.',
  },
  {
    icon: FlaskConical,
    title: 'Backtesting Engine',
    description:
      'Test trading strategies against historical data. Configure entry/exit rules, position sizing (fixed or Kelly criterion), and risk management. Detailed performance reports with equity curves.',
  },
];

export default function DocsPage() {
  return (
    <ContentLayout
      title="Documentation"
      subtitle="Learn how to get the most out of AlgoCrypto's cryptocurrency portfolio tracking platform."
    >
      {/* Getting Started */}
      <section className="mb-16">
        <h2 className="text-xl font-bold sm:text-2xl">Getting Started</h2>
        <div className="mt-6 space-y-6">
          <div className="flex gap-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/5">
              <Rocket className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">1. Create an Account</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Register with your email and password. No credit card required, all core features are free.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/5">
              <Briefcase className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">2. Build Your Portfolio</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Create portfolios, add holdings with quantity and cost basis, and build a watchlist. Live prices are pulled from Binance automatically.
              </p>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/5">
              <Settings className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">3. Configure Your Dashboard</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Set up your watchlist, create portfolios, and configure alert thresholds. The dashboard updates in real time via WebSocket connections.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section>
        <h2 className="text-xl font-bold sm:text-2xl">Feature Reference</h2>
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-border/50 bg-card p-5"
            >
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-primary/20 bg-primary/5">
                <feature.icon className="h-4 w-4 text-primary" />
              </div>
              <h3 className="font-semibold">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>
    </ContentLayout>
  );
}
