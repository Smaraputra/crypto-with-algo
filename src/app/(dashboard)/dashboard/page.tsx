import { auth } from '@/lib/auth';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { MarketOverview } from '@/components/market/MarketOverview';
import { LazyDashboardChart } from '@/components/chart/LazyDashboardChart';
import { NewsFeed } from '@/components/market/NewsFeed';
import { SentimentGauge } from '@/components/market/SentimentGauge';

export default async function DashboardPage() {
  const session = await auth();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Dashboard</h1>
      <p className="text-sm text-muted-foreground">
        Welcome{session?.user?.name ? `, ${session.user.name}` : ''}.
      </p>
      <ErrorBoundary
        fallback={
          <p className="text-sm text-muted-foreground">
            Market data unavailable
          </p>
        }
      >
        <MarketOverview />
      </ErrorBoundary>
      <ErrorBoundary
        fallback={
          <div className="flex h-[500px] items-center justify-center rounded-lg border border-border">
            <p className="text-sm text-muted-foreground">Chart unavailable</p>
          </div>
        }
      >
        <LazyDashboardChart />
      </ErrorBoundary>
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Market Sentiment</h2>
        <ErrorBoundary
          fallback={
            <p className="text-sm text-muted-foreground">Sentiment unavailable</p>
          }
        >
          <SentimentGauge />
        </ErrorBoundary>
      </div>
      <div className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold mb-3">Crypto News</h2>
        <ErrorBoundary
          fallback={
            <p className="text-sm text-muted-foreground">News unavailable</p>
          }
        >
          <NewsFeed />
        </ErrorBoundary>
      </div>
    </div>
  );
}
