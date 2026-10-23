'use client';

import React from 'react';
import { useFearAndGreed } from '@/hooks/useSentiment';
import { useLatestNews } from '@/hooks/useNews';
import { cn } from '@/lib/utils';
import { decodeHtmlEntities } from '@/lib/text/decode-entities';
import { formatRelativeTime } from './formatters';

export interface MarketFootProps {
  className?: string;
}

export const MarketFoot: React.FC<MarketFootProps> = ({ className }) => {
  const { data: sentimentData, isError: sentimentError } = useFearAndGreed();
  const { data: newsData, isError: newsError } = useLatestNews();

  const sentiment = sentimentData?.sentiment;
  const articles = (newsData?.articles ?? []).slice(0, 5);

  return (
    <footer
      aria-label="Market footer"
      className={cn('flex flex-col gap-6 pt-6 border-t border-edge', className)}
    >
      {!sentimentError && sentiment && (
        <p className="text-[14px] text-muted-foreground font-sans tabular-nums">
          Fear and Greed: {sentiment.fearGreedIndex}, {sentiment.label}.
        </p>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="text-[14px] font-semibold text-foreground">Latest headlines</h3>
        {newsError ? (
          <p className="text-[14px] text-muted-foreground">Headlines did not load.</p>
        ) : (
          <div className="flex flex-col divide-y divide-edge/60">
            {articles.map((article) => (
              <a
                key={article.id || article.url}
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'min-h-[44px] py-2.5 flex flex-col justify-center group cursor-pointer',
                  'focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline rounded-[6px]'
                )}
              >
                <span className="text-[14px] font-medium text-foreground group-hover:underline">
                  {decodeHtmlEntities(article.title)}
                </span>
                <span className="text-[12px] text-muted-foreground mt-0.5 font-sans tabular-nums">
                  {decodeHtmlEntities(article.source)}, {formatRelativeTime(article.publishedOn)}
                </span>
              </a>
            ))}
          </div>
        )}
      </div>

      <div className="pt-2">
        <a
          href="https://www.binance.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline"
        >
          Market data from Binance
        </a>
      </div>
    </footer>
  );
};
