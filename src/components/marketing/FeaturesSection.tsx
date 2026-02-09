import {
  Briefcase,
  TrendingUp,
  Bell,
  BarChart3,
  CandlestickChart,
  Download,
} from 'lucide-react';
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

export function FeaturesSection() {
  return (
    <section className="border-t border-border bg-card/30 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl px-4">
        <h2 className="text-center text-2xl font-bold tracking-tight sm:text-3xl">
          Everything You Need
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
          Professional-grade tools for managing your cryptocurrency portfolio.
        </p>

        <div
          className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="features-grid"
        >
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="border-border/50">
              <CardContent className="pt-6">
                <feature.icon className="mb-3 h-8 w-8 text-primary" />
                <h3 className="text-sm font-semibold">{feature.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {feature.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
