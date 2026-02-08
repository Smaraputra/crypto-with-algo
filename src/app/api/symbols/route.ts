import { NextResponse } from 'next/server';
import { fetchSymbols } from '@/lib/binance';
import { cachedFetch } from '@/lib/redis';

export async function GET() {
  try {
    const symbols = await cachedFetch(
      'symbols:usdt',
      () => fetchSymbols(),
      3600
    );

    return NextResponse.json(symbols);
  } catch (error) {
    console.error('Failed to fetch symbols:', error);
    return NextResponse.json({ error: 'Failed to fetch symbols' }, { status: 500 });
  }
}
