import { ContentLayout } from '@/components/marketing/ContentLayout';

const ARTICLES = [
  {
    title: 'Understanding Technical Indicators for Crypto Trading',
    date: '2025-01-15',
    readTime: '8 min read',
    category: 'Education',
    excerpt:
      'Learn how RSI, MACD, and Bollinger Bands work together to provide actionable trading signals. We break down each indicator and explain how CryptoWithAlgo combines them for multi-factor analysis.',
  },
  {
    title: 'Building a Diversified Crypto Portfolio',
    date: '2025-01-08',
    readTime: '6 min read',
    category: 'Strategy',
    excerpt:
      'Explore portfolio construction strategies including equal weighting, market-cap weighting, and risk parity. Understand correlation analysis and how to use the analytics dashboard for rebalancing.',
  },
  {
    title: 'Backtesting Strategies: From Hypothesis to Validation',
    date: '2024-12-20',
    readTime: '10 min read',
    category: 'Tutorial',
    excerpt:
      'A step-by-step guide to using the CryptoWithAlgo backtesting engine. Configure entry/exit rules, set position sizing with Kelly criterion, and interpret performance metrics like Sharpe ratio and max drawdown.',
  },
  {
    title: 'Real-Time Alerts: Never Miss a Market Move',
    date: '2024-12-12',
    readTime: '5 min read',
    category: 'Product',
    excerpt:
      'Set up intelligent price alerts with percentage-change triggers and recurring schedules. Learn best practices for configuring alert thresholds to minimize noise while capturing meaningful moves.',
  },
];

const CATEGORY_COLORS: Record<string, string> = {
  Education: 'bg-primary/10 text-primary',
  Strategy: 'bg-accent/10 text-accent',
  Tutorial: 'bg-chart-4/20 text-chart-4',
  Product: 'bg-chart-5/20 text-chart-5',
};

export default function BlogPage() {
  return (
    <ContentLayout
      title="Blog"
      subtitle="Insights, tutorials, and product updates from the CryptoWithAlgo team."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        {ARTICLES.map((article) => (
          <article
            key={article.title}
            className="group rounded-xl border border-border/50 bg-card p-6 transition-all duration-300 hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5"
          >
            <div className="flex items-center gap-3">
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CATEGORY_COLORS[article.category] ?? 'bg-muted text-muted-foreground'}`}
              >
                {article.category}
              </span>
              <span className="text-xs text-muted-foreground">
                {article.readTime}
              </span>
            </div>
            <h2 className="mt-3 font-semibold leading-snug transition-colors group-hover:text-primary">
              {article.title}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {article.excerpt}
            </p>
            <div className="mt-4 text-xs text-muted-foreground">
              {new Date(article.date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </div>
          </article>
        ))}
      </div>
    </ContentLayout>
  );
}
