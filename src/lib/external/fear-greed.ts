import { cachedFetch } from '@/lib/redis';
import type { SentimentData } from '@/types/signal';

interface FearGreedApiResponse {
  data: Array<{
    value: string;
    value_classification: string;
    timestamp: string;
  }>;
}

const FEAR_GREED_URL = 'https://api.alternative.me/fng/?limit=1&format=json';
const CACHE_TTL = 300; // 5 minutes

async function fetchRaw(): Promise<SentimentData> {
  const res = await fetch(FEAR_GREED_URL, {
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Fear & Greed API returned ${res.status}`);
  }

  const json = (await res.json()) as FearGreedApiResponse;
  const entry = json.data?.[0];

  if (!entry) {
    throw new Error('No Fear & Greed data returned');
  }

  return {
    fearGreedIndex: parseInt(entry.value, 10),
    label: entry.value_classification,
  };
}

export async function fetchFearAndGreed(): Promise<SentimentData> {
  return cachedFetch('sentiment:fear-greed', fetchRaw, CACHE_TTL);
}

export interface FearGreedHistoryEntry {
  timestamp: number; // ms, UTC midnight of the day the reading covers
  fearGreedIndex: number;
  label: string;
}

const HISTORY_CACHE_TTL = 3600; // 1 hour

async function fetchHistoryRaw(days: number): Promise<FearGreedHistoryEntry[]> {
  const res = await fetch(`https://api.alternative.me/fng/?limit=${days}&format=json`, {
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Fear & Greed API returned ${res.status}`);
  }

  const json = (await res.json()) as FearGreedApiResponse;
  const entries = json.data ?? [];

  // One entry per day, newest first, unix-second timestamps at UTC midnight
  return entries.map((entry) => ({
    timestamp: parseInt(entry.timestamp, 10) * 1000,
    fearGreedIndex: parseInt(entry.value, 10),
    label: entry.value_classification,
  }));
}

export async function fetchFearAndGreedHistory(days: number): Promise<FearGreedHistoryEntry[]> {
  return cachedFetch(
    `sentiment:fear-greed-history:${days}`,
    () => fetchHistoryRaw(days),
    HISTORY_CACHE_TTL
  );
}
