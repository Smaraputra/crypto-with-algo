import {
  Briefcase,
  TrendingUp,
  Bell,
  BarChart3,
  CandlestickChart,
  Brain,
  FlaskConical,
  Wifi,
  Shield,
  Layers,
  Clock,
} from 'lucide-react';
import { ContentLayout } from '@/components/marketing/ContentLayout';

const FEATURES = [
  {
    icon: Briefcase,
    title: 'Portfolio Management',
    description:
      'Create multiple portfolios with custom names. Add holdings manually with quantity, purchase price, and date. Track real-time valuations powered by live Binance price feeds.',
    highlights: [
      'Multiple portfolios with custom names',
      'Real-time P&L and unrealized gains',
      'Cost basis tracking per holding',
    ],
  },
  {
    icon: TrendingUp,
    title: 'Live Market Data',
    description:
      'WebSocket-powered price feeds from Binance deliver sub-second updates across all tracked symbols. The watchlist and dashboard refresh automatically with no manual polling.',
    highlights: [
      'Sub-second WebSocket price updates',
      '24h change, volume, and market cap',
      'Configurable watchlist with quick add',
    ],
  },
  {
    icon: CandlestickChart,
    title: 'Interactive Charts',
    description:
      'Professional candlestick charts powered by KlineCharts with multiple timeframes from 1 minute to 1 month. Overlay technical indicators for deeper market analysis.',
    highlights: [
      'Timeframes: 1m, 5m, 15m, 1h, 4h, 1d, 1w, 1M',
      'Indicators: MA, EMA, Bollinger Bands, Volume',
      'Crosshair, zoom, and pan controls',
    ],
  },
  {
    icon: Bell,
    title: 'Smart Alerts',
    description:
      'Configure price alerts with above/below thresholds. Set portfolio value alerts and percentage-change triggers. Alerts can be one-time or recurring with customizable cooldown periods.',
    highlights: [
      'Price above/below triggers',
      'Portfolio value and % change alerts',
      'One-time or recurring with cooldown',
    ],
  },
  {
    icon: BarChart3,
    title: 'Analytics Dashboard',
    description:
      'Visualize portfolio performance with interactive area charts. Track risk metrics including Sharpe ratio, Sortino ratio, max drawdown, and Value at Risk across configurable time windows.',
    highlights: [
      'Sharpe ratio, Sortino ratio, VaR',
      'Max drawdown and recovery analysis',
      'CSV export for reporting',
    ],
  },
  {
    icon: Brain,
    title: 'Trading Signals',
    description:
      'Multi-indicator signal engine combining RSI, MACD, Stochastic RSI, and Ichimoku Cloud. Aggregated confidence scores produce Strong Buy to Strong Sell ratings per symbol.',
    highlights: [
      'RSI, MACD, StochRSI, Ichimoku Cloud',
      'Aggregated confidence scoring',
      'Signal history with timestamps',
    ],
  },
  {
    icon: FlaskConical,
    title: 'Backtesting Engine',
    description:
      'Test trading strategies against historical Binance data. Configure entry/exit rules, position sizing with fixed or Kelly criterion, and risk management parameters.',
    highlights: [
      'Historical data from Binance',
      'Fixed and Kelly criterion sizing',
      'Equity curves and performance reports',
    ],
  },
];

const PLATFORM_HIGHLIGHTS = [
  {
    icon: Wifi,
    title: 'Real-Time Architecture',
    description:
      'Built on WebSocket connections for instant price updates. No polling, no delays.',
  },
  {
    icon: Shield,
    title: 'Security First',
    description:
      'Session-based authentication with encrypted credentials. No exchange keys required.',
  },
  {
    icon: Layers,
    title: 'Multi-Exchange Ready',
    description:
      'Binance integration live. Architecture designed for additional exchange support.',
  },
  {
    icon: Clock,
    title: '24/7 Monitoring',
    description:
      'Continuous market monitoring with automated alert evaluation every minute.',
  },
];

export default function FeaturesPage() {
  return (
    <ContentLayout
      title="Features"
      subtitle="Professional-grade tools for managing your cryptocurrency portfolio, from live market data to backtesting strategies."
    >
      {/* Platform highlights */}
      <section className="mb-16">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PLATFORM_HIGHLIGHTS.map((item) => (
            <div
              key={item.title}
              className="rounded-lg border border-border/50 bg-card/50 p-4 text-center"
            >
              <item.icon className="mx-auto h-5 w-5 text-primary" />
              <h3 className="mt-2 text-sm font-semibold">{item.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Feature cards */}
      <section>
        <h2 className="text-xl font-bold sm:text-2xl">Core Features</h2>
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
              <ul className="mt-3 space-y-1">
                {feature.highlights.map((h) => (
                  <li
                    key={h}
                    className="flex items-start gap-2 text-xs text-muted-foreground"
                  >
                    <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </ContentLayout>
  );
}
