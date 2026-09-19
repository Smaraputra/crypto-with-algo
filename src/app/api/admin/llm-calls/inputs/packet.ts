import { createHash } from 'crypto';

import { dropOpenBars } from '@/lib/candle-ingestion';
import { intervalToMs } from '@/lib/intervals';
import { llmStyleForInterval } from '@/lib/models/llm-call';
import type { IHistoricalSnapshot } from '@/lib/models/historical-snapshot';
import type { TradingStyle } from '@/lib/models/signal-template';
import type { OHLCV } from '@/types/market';

/** Everything the packet reads, injected so the builder is testable without Mongo or the network. */
export interface PacketDeps {
  getCandles: (symbol: string, interval: string, limit: number) => Promise<OHLCV[]>;
  findLatestSignal: (symbol: string, interval: string, atOrBefore: number) => Promise<PacketSignal | null>;
  findLatestSnapshot: (symbol: string, interval: string, atOrBefore: number) => Promise<PacketSnapshot | null>;
  fetchNews: (symbol: string) => Promise<Array<{ title: string; source: string; url: string; publishedOn: number }>>;
}

export interface PacketSignal {
  score: number;
  tier: string;
  confidence: number;
  candleTimestamp: number;
  components: Array<{
    category: string;
    score: number;
    weight: number;
    signals: Array<{ name: string; direction: string; strength: number; description: string }>;
  }>;
}

export interface PacketSnapshot {
  timestamp: number;
  data: IHistoricalSnapshot['data'];
}

export interface InputsPacket {
  symbol: string;
  interval: string;
  tradingStyle: TradingStyle;
  lastClosedBar: { timestamp: number; closeTime: number; open: number; high: number; low: number; close: number; volume: number };
  closes: number[];
  signal: PacketSignal | null;
  snapshot: (IHistoricalSnapshot['data'] & { timestamp: number }) | null;
  news: Array<{ title: string; source: string; url: string; publishedAt: string }>;
  inputsHash: string;
  generatedAt: string;
}

const CLOSES = 60;
const NEWS_ITEMS = 10;

/**
 * Point-in-time inputs for one LLM call: nothing in the packet postdates the
 * close of the last closed bar. Candles come from the store with the open
 * bar dropped; the signal and snapshot are the latest at or before that
 * close; news is filtered to items published at or before it. The hash
 * covers everything but generatedAt, so a repeated request for the same bar
 * hashes the same and the call can prove what it read.
 */
export async function buildInputsPacket(
  deps: PacketDeps,
  symbol: string,
  interval: string,
  now: number
): Promise<InputsPacket | null> {
  const ms = intervalToMs(interval);
  const closed = dropOpenBars(await deps.getCandles(symbol, interval, CLOSES + 2), interval, now);
  if (closed.length === 0) return null;

  const last = closed[closed.length - 1];
  const closeTime = last.timestamp + ms;
  const tradingStyle = llmStyleForInterval(interval);

  const signal = await deps.findLatestSignal(symbol, interval, last.timestamp);
  const snapshotDoc = await deps.findLatestSnapshot(symbol, interval, closeTime);

  let news: InputsPacket['news'] = [];
  try {
    news = (await deps.fetchNews(symbol))
      .filter((item) => item.publishedOn * 1000 <= closeTime)
      .slice(0, NEWS_ITEMS)
      .map((item) => ({
        title: item.title,
        source: item.source,
        url: item.url,
        publishedAt: new Date(item.publishedOn * 1000).toISOString(),
      }));
  } catch {
    news = [];
  }

  const body = {
    symbol,
    interval,
    tradingStyle,
    lastClosedBar: {
      timestamp: last.timestamp,
      closeTime,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume,
    },
    closes: closed.slice(-CLOSES).map((c) => c.close),
    signal,
    snapshot: snapshotDoc ? { timestamp: snapshotDoc.timestamp, ...snapshotDoc.data } : null,
    news,
  };

  const inputsHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { ...body, inputsHash, generatedAt: new Date(now).toISOString() };
}
