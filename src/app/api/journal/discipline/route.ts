import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry } from '@/lib/models/journal-entry';
import { evaluateDiscipline, type DisciplineTrade } from '@/lib/discipline';
import { EFFECTIVE_ENTERED_AT } from '@/lib/journal/times';

const LOOKBACK_MS = 15 * 24 * 60 * 60 * 1000; // engine reads today + 14 prior days

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const candidateSymbol = searchParams.get('symbol') ?? undefined;

  await connectDB();

  const cutoff = new Date(Date.now() - LOOKBACK_MS);

  const rawEntries = (await JournalEntry.find(
    {
      userId: session.user.id,
      $expr: { $gte: [EFFECTIVE_ENTERED_AT, cutoff] },
      action: { $in: ['buy', 'sell'] },
    },
    {
      symbol: 1,
      enteredAt: 1,
      exitedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      outcomePnlPercent: 1,
    }
  ).lean()) as Array<{
    symbol: string;
    enteredAt?: Date | null;
    exitedAt?: Date | null;
    createdAt: Date;
    updatedAt?: Date;
    outcomePnlPercent?: number | null;
  }>;

  const entries = rawEntries.slice().sort((a, b) => {
    const timeA = new Date((a.enteredAt ?? a.createdAt) as Date).getTime();
    const timeB = new Date((b.enteredAt ?? b.createdAt) as Date).getTime();
    return timeA - timeB;
  });

  const trades: DisciplineTrade[] = entries.map((e) => {
    const closedAt = e.exitedAt
      ? new Date(e.exitedAt as Date).getTime()
      : e.outcomePnlPercent != null && e.updatedAt
        ? new Date(e.updatedAt as Date).getTime()
        : undefined;

    return {
      symbol: e.symbol,
      createdAt: new Date((e.enteredAt ?? e.createdAt) as Date).getTime(),
      closedAt,
      pnlPercent: (e.outcomePnlPercent as number | null) ?? null,
    };
  });

  const nudges = evaluateDiscipline(trades, { candidateSymbol });

  return NextResponse.json({ nudges });
}
