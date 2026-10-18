import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { LabScore } from '@/lib/models/lab-score';
import { LabSignal } from '@/lib/models/lab-signal';
import {
  LAB_HYPOTHESES_V2,
  LAB_V2_THRESHOLD,
  LAB_VERSION_V2,
} from '@/lib/signals/lab/candidates';
import { eValue, initialEState } from '@/lib/signals/lab/e-process';
import {
  addMonthsUtc,
  labStatus,
  type LabV2HypothesisView,
  type LabV2Response,
} from '@/lib/signals/lab/view';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await connectDB();
    const now = Date.now();

    const hypotheses: LabV2HypothesisView[] = await Promise.all(
      LAB_HYPOTHESES_V2.map(async (hyp) => {
        const [latest, first, gradedBars, latestSignal, bettingScores] = await Promise.all([
          LabScore.findOne({ version: LAB_VERSION_V2, hypothesis: hyp.id })
            .sort({ barClose: -1 })
            .lean(),
          LabScore.findOne({ version: LAB_VERSION_V2, hypothesis: hyp.id })
            .sort({ barClose: 1 })
            .lean(),
          LabScore.countDocuments({ version: LAB_VERSION_V2, hypothesis: hyp.id }),
          LabSignal.findOne({ version: LAB_VERSION_V2, hypothesis: hyp.id })
            .sort({ barClose: -1 })
            .lean(),
          LabScore.find({ version: LAB_VERSION_V2, hypothesis: hyp.id, bet: true })
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
        const testEndsAt = firstGradedAt !== null ? new Date(addMonthsUtc(firstGradedAt, 24)).toISOString() : null;

        let meanNetReturn: number | null = null;
        let lastNetReturn: number | null = null;
        if (bettingScores.length > 0) {
          const returns = bettingScores
            .map((r) => r.netBookReturn)
            .filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
          if (returns.length > 0) {
            meanNetReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
          }
          const lastBettingRow = bettingScores[bettingScores.length - 1];
          lastNetReturn =
            typeof lastBettingRow.netBookReturn === 'number' && Number.isFinite(lastBettingRow.netBookReturn)
              ? lastBettingRow.netBookReturn
              : null;
        }

        let latestBar: LabV2HypothesisView['latestBar'] = null;
        if (latestSignal) {
          const positions = Object.entries(latestSignal.scores ?? {})
            .map(([symbol, weight]) => ({ symbol, weight: Number(weight) }))
            .sort((a, b) => {
              if (b.weight !== a.weight) {
                return b.weight - a.weight;
              }
              return a.symbol.localeCompare(b.symbol);
            });

          latestBar = {
            barClose: new Date(latestSignal.barClose).toISOString(),
            late: Boolean(latestSignal.late),
            positions,
            cash: positions.length === 0,
          };
        }

        return {
          id: hyp.id,
          candidate: hyp.candidate as 'N2' | 'N3',
          timeframe: hyp.timeframe as '1w' | '1d',
          status,
          underTestSince,
          testEndsAt,
          validatedAt,
          gradedBars,
          betBars,
          e,
          threshold: LAB_V2_THRESHOLD,
          absorbed,
          meanNetReturn,
          lastNetReturn,
          scale: hyp.scale ?? 1,
          latestBar,
        };
      })
    );

    const response: LabV2Response = {
      version: 'lab-v2',
      threshold: LAB_V2_THRESHOLD,
      hypotheses,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[signals/lab-v2] read failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
