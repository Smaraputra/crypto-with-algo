import { NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/admin-auth';
import { connectDB } from '@/lib/mongodb';
import { PaperBook } from '@/lib/models/paper-book';
import { PaperLedger } from '@/lib/models/paper-ledger';
import { PaperTrade, type IPaperTrade } from '@/lib/models/paper-trade';
import { BOOK_START_EQUITY, DESK_BOOKS } from '@/lib/paper-desk/books';
import { buildBookReport, equityCurveFromTrades } from '@/lib/paper-desk/report';
import { SCORER_CONFIG_VERSION } from '@/lib/signals/config-version';

/**
 * GET /api/admin/paper-desk
 *
 * Every book's realised record, with an equity curve per track. Admin-only:
 * the desk is global, like the outcome record it sits beside. Read-only.
 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: admin.reason === 'not-configured' ? 503 : 403 }
    );
  }

  await connectDB();

  const books = [];
  for (const key of DESK_BOOKS) {
    const filter = { tradingStyle: key.tradingStyle, interval: key.interval };
    // The current scorer epoch only: trades opened under an earlier
    // configVersion, including the epoch_end closes, belong to another record.
    const trades = await PaperTrade.find({ ...filter, entryConfigVersion: SCORER_CONFIG_VERSION })
      .sort({ exitTime: 1 })
      .lean<IPaperTrade[]>();
    const ledgers = await PaperLedger.find(filter).lean();
    const book = await PaperBook.findOne(filter).lean();
    const startEquity = ledgers.length * BOOK_START_EQUITY;

    books.push({
      ...buildBookReport(key, trades, ledgers, book),
      engineCurve: equityCurveFromTrades(
        trades.map((t) => ({ exitTime: t.exitTime, pnl: t.engine.pnl })),
        startEquity
      ),
      executableCurve: equityCurveFromTrades(
        trades
          .filter((t) => t.executable.filled)
          .map((t) => ({ exitTime: t.exitTime, pnl: t.executable.pnl })),
        startEquity
      ),
    });
  }

  return NextResponse.json({ books });
}
