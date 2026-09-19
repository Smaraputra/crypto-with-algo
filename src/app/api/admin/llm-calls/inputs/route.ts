import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { connectDB } from '@/lib/mongodb';
import { getCandles } from '@/lib/candle-ingestion';
import { GlobalSignal } from '@/lib/models/global-signal';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { LLM_CALL_INTERVALS, llmStyleForInterval } from '@/lib/models/llm-call';
import { mapToSnapshotInterval } from '@/lib/backtest/snapshot-series';
import { fetchCryptoNews } from '@/lib/external/crypto-news';
import { authorizeLlmPanel } from '../auth';
import { buildInputsPacket, type PacketDeps, type PacketSignal, type PacketSnapshot } from './packet';

const querySchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{5,20}$/),
  interval: z.enum(LLM_CALL_INTERVALS),
});

const deps: PacketDeps = {
  getCandles: (symbol, interval, limit) => getCandles(symbol, interval, undefined, undefined, limit),
  findLatestSignal: async (symbol, interval, atOrBefore) => {
    const doc = (await GlobalSignal.findOne({
      symbol,
      interval,
      tradingStyle: llmStyleForInterval(interval),
      candleTimestamp: { $lte: atOrBefore },
    })
      .sort({ candleTimestamp: -1 })
      .lean()) as unknown as PacketSignal | null;
    if (!doc) return null;
    return {
      score: doc.score,
      tier: doc.tier,
      confidence: doc.confidence,
      candleTimestamp: doc.candleTimestamp,
      components: doc.components.map((c) => ({
        category: c.category,
        score: c.score,
        weight: c.weight,
        signals: c.signals.map((s) => ({ name: s.name, direction: s.direction, strength: s.strength, description: s.description })),
      })),
    };
  },
  findLatestSnapshot: async (symbol, interval, atOrBefore) => {
    const doc = (await HistoricalSnapshot.findOne({
      symbol,
      interval: mapToSnapshotInterval(interval),
      timestamp: { $lte: atOrBefore },
    })
      .sort({ timestamp: -1 })
      .lean()) as unknown as PacketSnapshot | null;
    return doc ? { timestamp: doc.timestamp, data: doc.data } : null;
  },
  fetchNews: (symbol) => fetchCryptoNews(symbol.replace(/USDT$/, '')),
};

export async function GET(req: NextRequest) {
  const auth = await authorizeLlmPanel(req);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  await connectDB();
  const packet = await buildInputsPacket(deps, parsed.data.symbol, parsed.data.interval, Date.now());
  if (!packet) {
    return NextResponse.json({ error: 'No closed bar stored for this symbol and interval' }, { status: 404 });
  }
  return NextResponse.json(packet);
}
