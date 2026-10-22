import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { LabScore } from '@/lib/models/lab-score';
import { LabSignal } from '@/lib/models/lab-signal';
import {
  LAB_HYPOTHESES_V4,
  LAB_V4_HOLD_MS,
  LAB_V4_THRESHOLD,
  LAB_VERSION_V4,
  labDelayMs,
} from '@/lib/signals/lab/candidates';
import { eValue, initialEState } from '@/lib/signals/lab/e-process';
import {
  addMonthsUtc,
  labStatus,
  type LabV4HypothesisView,
  type LabV4Response,
} from '@/lib/signals/lab/view';

export const dynamic = 'force-dynamic';

const SYMBOL_REGEX = /^[A-Z0-9]{2,20}USDT$/;
const FOURTEEN_DAYS_MS = 14 * 86_400_000;

export async function GET(request?: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = request ? new URL(request.url) : null;
  const symbolParam = url?.searchParams.get('symbol');

  if (symbolParam !== null && symbolParam !== undefined) {
    if (!SYMBOL_REGEX.test(symbolParam)) {
      return NextResponse.json({ error: 'Invalid symbol parameter' }, { status: 400 });
    }
  }

  try {
    await connectDB();
    const now = Date.now();
    const D = labDelayMs('1h');
    const openTradesMinBarClose = now - LAB_V4_HOLD_MS - D;

    const hypotheses: LabV4HypothesisView[] = await Promise.all(
      LAB_HYPOTHESES_V4.map(async (hyp) => {
        const [latest, first, gradedBars, latestSignal, bettingScores, openTradeSignals] =
          await Promise.all([
            LabScore.findOne({ version: LAB_VERSION_V4, hypothesis: hyp.id })
              .sort({ barClose: -1 })
              .lean(),
            LabScore.findOne({ version: LAB_VERSION_V4, hypothesis: hyp.id })
              .sort({ barClose: 1 })
              .lean(),
            LabScore.countDocuments({ version: LAB_VERSION_V4, hypothesis: hyp.id }),
            LabSignal.findOne({ version: LAB_VERSION_V4, hypothesis: hyp.id })
              .sort({ barClose: -1 })
              .lean(),
            LabScore.find({ version: LAB_VERSION_V4, hypothesis: hyp.id, bet: true })
              .sort({ barClose: 1 })
              .lean(),
            LabSignal.find({
              version: LAB_VERSION_V4,
              hypothesis: hyp.id,
              barClose: { $gt: openTradesMinBarClose },
            })
              .sort({ barClose: 1 })
              .lean(),
          ]);

        const state = latest?.state ?? initialEState();
        const e = eValue(state);
        const betBars = state.n;
        const absorbed = state.absorbed === true;
        const validatedAt = state.crossedAt !== null ? new Date(state.crossedAt).toISOString() : null;

        const firstGradedAt = first?.barClose ?? null;
        const status = labStatus({ firstGradedAt, crossedAt: state.crossedAt, now });
        const underTestSince = firstGradedAt !== null ? new Date(firstGradedAt).toISOString() : null;
        const testEndsAt =
          firstGradedAt !== null ? new Date(addMonthsUtc(firstGradedAt, 24)).toISOString() : null;

        let meanNetReturn: number | null = null;
        let meanNetPerTrade: number | null = null;
        let lastNetReturn: number | null = null;
        if (bettingScores.length > 0) {
          const returns = bettingScores
            .map((r) => r.netBookReturn)
            .filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
          if (returns.length > 0) {
            meanNetReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
          }

          let sumNet = 0;
          let sumN = 0;
          for (const r of bettingScores) {
            if (typeof r.netBookReturn === 'number' && Number.isFinite(r.netBookReturn)) {
              sumNet += r.netBookReturn;
            }
            if (typeof r.n === 'number' && Number.isFinite(r.n)) {
              sumN += r.n;
            }
          }
          if (sumN > 0) {
            meanNetPerTrade = sumNet / sumN;
          }

          const lastBettingRow = bettingScores[bettingScores.length - 1];
          lastNetReturn =
            typeof lastBettingRow.netBookReturn === 'number' &&
            Number.isFinite(lastBettingRow.netBookReturn)
              ? lastBettingRow.netBookReturn
              : null;
        }

        const openTrades: LabV4HypothesisView['openTrades'] = [];
        for (const sig of openTradeSignals) {
          if (sig.scores && typeof sig.scores === 'object') {
            const coinEntries = Object.entries(sig.scores)
              .filter(([, score]) => score === 1 || score === -1)
              .sort(([a], [b]) => a.localeCompare(b));
            for (const [sym, side] of coinEntries) {
              const enteredAtMs = sig.barClose + D;
              const exitsAtMs = enteredAtMs + LAB_V4_HOLD_MS;
              openTrades.push({
                symbol: sym,
                side: side as 1 | -1,
                enteredAt: new Date(enteredAtMs).toISOString(),
                exitsAt: new Date(exitsAtMs).toISOString(),
              });
            }
          }
        }

        let latestBar: LabV4HypothesisView['latestBar'] = null;
        if (latestSignal) {
          const entries = Object.entries(latestSignal.scores ?? {})
            .filter(([, side]) => side === 1 || side === -1)
            .map(([symbol, side]) => ({ symbol, side: side as 1 | -1 }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol));

          latestBar = {
            barClose: new Date(latestSignal.barClose).toISOString(),
            late: Boolean(latestSignal.late),
            entries,
          };
        }

        return {
          id: hyp.id,
          candidate: hyp.candidate as 'S1' | 'S2',
          timeframe: hyp.timeframe as '1h',
          status,
          underTestSince,
          testEndsAt,
          validatedAt,
          gradedBars,
          betBars,
          e,
          threshold: LAB_V4_THRESHOLD,
          absorbed,
          meanNetReturn,
          meanNetPerTrade,
          lastNetReturn,
          scale: hyp.scale ?? 1,
          openTrades,
          latestBar,
        };
      })
    );

    let entries: LabV4Response['entries'];
    if (symbolParam) {
      const fourteenDaysAgo = now - FOURTEEN_DAYS_MS;
      const signalRows = await LabSignal.find({
        version: LAB_VERSION_V4,
        hypothesis: { $in: LAB_HYPOTHESES_V4.map((h) => h.id) },
        barClose: { $gte: fourteenDaysAgo },
      })
        .sort({ barClose: 1, hypothesis: 1 })
        .lean();

      entries = [];
      for (const sig of signalRows) {
        const side = sig.scores?.[symbolParam];
        if (side === 1 || side === -1) {
          entries.push({
            hypothesis: sig.hypothesis,
            barClose: new Date(sig.barClose).toISOString(),
            symbol: symbolParam,
            side: side as 1 | -1,
          });
        }
      }
    }

    const response: LabV4Response = {
      version: 'lab-v4',
      threshold: LAB_V4_THRESHOLD,
      hypotheses,
      ...(entries !== undefined ? { entries } : {}),
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[signals/lab-v4] read failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
