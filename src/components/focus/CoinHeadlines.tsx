'use client';

import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { useLatestNews } from '@/hooks/useNews';
import { cn } from '@/lib/utils';
import { EvidenceTag } from './EvidenceTag';
import { formatAge } from './format';

export interface CoinHeadlinesProps {
  symbol: string;
  className?: string;
}

export function CoinHeadlines({ symbol, className }: CoinHeadlinesProps) {
  const headingId = useId();
  const baseAsset = symbol.replace(/USDT$/, '');
  const { data, isLoading, error, refetch } = useLatestNews(baseAsset);

  if (isLoading) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="coin-headlines"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Headlines</h3>
          <EvidenceTag kind="context" />
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          Loading headlines...
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="coin-headlines"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Headlines</h3>
          <EvidenceTag kind="context" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-destructive">
            Could not load headlines: {error.message}.
          </p>
          <Button
            variant="outline"
            size="xs"
            className="min-h-11 sm:min-h-6"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </div>
      </section>
    );
  }

  if (!data?.articles || data.articles.length === 0) {
    return (
      <section
        aria-labelledby={headingId}
        data-testid="coin-headlines"
        className={cn('space-y-3 p-4', className)}
      >
        <div className="flex items-center justify-between">
          <h3 id={headingId} className="text-sm font-semibold">Headlines</h3>
          <EvidenceTag kind="context" />
        </div>
        <p className="text-sm text-muted-foreground">
          No recent headlines mention this coin.
        </p>
      </section>
    );
  }

  const articles = [...data.articles]
    .sort((a, b) => b.publishedOn - a.publishedOn)
    .slice(0, 5);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="coin-headlines"
      className={cn('space-y-3 p-4', className)}
    >
      <div className="flex items-center justify-between">
        <h3 id={headingId} className="text-sm font-semibold">Headlines</h3>
        <EvidenceTag kind="context" />
      </div>

      <ul className="space-y-2 text-xs">
        {articles.map((article) => (
          <li
            key={article.id || article.url || article.title}
            data-testid="headline-item"
            className="space-y-0.5 py-1.5 border-b border-border/50 last:border-b-0"
          >
            <div>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="line-clamp-2 font-medium text-foreground hover:underline"
              >
                {article.title}
              </a>
            </div>
            <div className="flex items-center gap-2 text-muted-foreground">
              {article.source && <span>{article.source}</span>}
              <span className="font-mono tabular-nums">
                {formatAge(article.publishedOn)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
