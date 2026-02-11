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
