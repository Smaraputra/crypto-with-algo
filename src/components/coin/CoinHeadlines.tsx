'use client';

import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { StateNotice } from '@/components/kit/StateNotice';
import { useLatestNews } from '@/hooks/useNews';
import { formatRelativeTime, getBaseAsset } from '@/components/market-home/formatters';
import { decodeHtmlEntities } from '@/lib/text/decode-entities';

export interface CoinHeadlinesProps {
  symbol: string;
  className?: string;
}

export const CoinHeadlines: React.FC<CoinHeadlinesProps> = ({ symbol, className }) => {
  const baseAsset = getBaseAsset(symbol);
  const { data, isError } = useLatestNews(baseAsset);

  const articles = (data?.articles ?? []).slice(0, 5);

  return (
    <Panel title="Headlines" className={className}>
      {isError ? (
        <StateNotice kind="error" title="Headlines did not load." />
      ) : articles.length === 0 ? (
        <p className="text-[14px] text-muted-foreground">No recent headlines.</p>
      ) : (
        <ul className="divide-y divide-line">
          {articles.map((article) => {
            const timeAgo = formatRelativeTime(article.publishedOn);

            return (
              <li key={article.id} className="py-3 first:pt-0 last:pb-0">
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col gap-1 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] rounded"
                >
                  <span className="text-[15px] font-medium text-foreground group-hover:underline leading-snug">
                    {decodeHtmlEntities(article.title)}
                  </span>
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                    <span>{decodeHtmlEntities(article.source)}</span>
                    <span aria-hidden="true">&middot;</span>
                    <span>{timeAgo}</span>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
};
