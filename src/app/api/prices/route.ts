import { NextResponse } from 'next/server';
import { fetchTickers } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';

const TOP_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'MATICUSDT', 'UNIUSDT', 'LTCUSDT', 'ATOMUSDT', 'NEARUSDT',
];

export async function GET() {
  try {
    const tickers = await cachedFetch('tickers:top', async () => {
      const all = await fetchTickers();
      return all.filter((t) => TOP_SYMBOLS.includes(t.symbol));
    }, 30);

    return NextResponse.json(tickers);
  } catch (error) {
    console.error('Failed to fetch tickers:', error);
    return NextResponse.json({ error: 'Failed to fetch prices' }, { status: 500 });
  }
}
