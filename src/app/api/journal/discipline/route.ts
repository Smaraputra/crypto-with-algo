import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry } from '@/lib/models/journal-entry';
import { evaluateDiscipline, type DisciplineTrade } from '@/lib/discipline';

const LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000; // engine reads today + 14 prior days

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const candidateSymbol = searchParams.get('symbol') ?? undefined;

  await connectDB();

  const entries = await JournalEntry.find(
    {
      userId: session.user.id,
      createdAt: { $gte: new Date(Date.now() - LOOKBACK_MS) },
      action: { $in: ['buy', 'sell'] },
    },
    { symbol: 1, createdAt: 1, updatedAt: 1, outcomePnlPercent: 1 }
  )
    .sort({ createdAt: 1 })
    .lean();

  const trades: DisciplineTrade[] = entries.map((e) => ({
    symbol: e.symbol as string,
    createdAt: new Date(e.createdAt as Date).getTime(),
    // updatedAt approximates close time for entries with an outcome
    closedAt:
      e.outcomePnlPercent != null && e.updatedAt
        ? new Date(e.updatedAt as Date).getTime()
        : undefined,
    pnlPercent: (e.outcomePnlPercent as number | null) ?? null,
  }));

  const nudges = evaluateDiscipline(trades, { candidateSymbol });

  return NextResponse.json({ nudges });
}
