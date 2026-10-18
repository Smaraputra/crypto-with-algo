import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { LabScore } from '@/lib/models/lab-score';
import { LabSignal } from '@/lib/models/lab-signal';
import { RvSignal } from '@/lib/models/rv-signal';
import { LAB_HYPOTHESES_V1, LAB_VERSION } from '@/lib/signals/lab/candidates';
import { eValue, eValue0, initialEState, LAB_THRESHOLD } from '@/lib/signals/lab/e-process';
import {
  addMonthsUtc,
  labStatus,
  rankCoins,
  type LabCoinView,
  type LabHypothesisView,
  type LabResponse,
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

    const hypotheses: LabHypothesisView[] = await Promise.all(
      LAB_HYPOTHESES_V1.map(async (hyp) => {
        const [latest, first, gradedBars, latestSignal] = await Promise.all([
          LabScore.findOne({ version: LAB_VERSION, hypothesis: hyp.id })
            .sort({ barClose: -1 })
            .lean(),
          LabScore.findOne({ version: LAB_VERSION, hypothesis: hyp.id })
            .sort({ barClose: 1 })
            .lean(),
          LabScore.countDocuments({ version: LAB_VERSION, hypothesis: hyp.id }),
          LabSignal.findOne({ version: LAB_VERSION, hypothesis: hyp.id })
            .sort({ barClose: -1 })
            .lean(),
        ]);

        const state = latest?.state ?? initialEState();
        const e = eValue(state);
        const e0 = eValue0(state);
        const betBars = state.n;
        const meanX = state.n > 0 ? state.sumX / state.n : null;
        const meanB = state.n > 0 ? (state.sumX - state.sumD) / state.n : null;
        const currentB = latest?.b ?? null;
        const validatedAt = state.crossedAt !== null ? new Date(state.crossedAt).toISOString() : null;

        const firstGradedAt = first?.barClose ?? null;
        const status = labStatus({ firstGradedAt, crossedAt: state.crossedAt, now });
        const underTestSince = firstGradedAt !== null ? new Date(firstGradedAt).toISOString() : null;
        const testEndsAt = firstGradedAt !== null ? new Date(addMonthsUtc(firstGradedAt, 24)).toISOString() : null;

        let latestBar: LabHypothesisView['latestBar'] = null;
        if (latestSignal) {
          let coins: LabCoinView[] = rankCoins(latestSignal.scores ?? {});
          if (hyp.candidate === 'L2') {
            const inputs = (latestSignal.inputs ?? {}) as {
              rvBarTime?: number | null;
              v8?: Record<string, { score?: number | null } | undefined>;
            };
            const rvBarTime = inputs.rvBarTime;
            let rvRankMap: Map<string, number> | null = null;
            if (rvBarTime !== null && rvBarTime !== undefined) {
              const rvDoc = await RvSignal.findOne({ version: 'rv-v1', barTime: rvBarTime }).lean();
              if (rvDoc?.ranked) {
                rvRankMap = new Map();
                for (const r of rvDoc.ranked) {
                  rvRankMap.set(r.symbol, r.rank);
                }
              }
            }

            coins = coins.map((coin) => ({
              ...coin,
              parts: {
                v8: inputs.v8?.[coin.symbol]?.score ?? null,
                rvRank: rvRankMap ? (rvRankMap.get(coin.symbol) ?? null) : null,
              },
            }));
          }

          latestBar = {
            barClose: new Date(latestSignal.barClose).toISOString(),
            late: Boolean(latestSignal.late),
            coins,
            skipped: (latestSignal.skipped ?? []).map((s) => ({
              symbol: s.symbol,
              reason: s.reason,
            })),
          };
        }

        return {
          id: hyp.id,
          candidate: hyp.candidate,
          timeframe: hyp.timeframe,
          status,
          underTestSince,
          testEndsAt,
          validatedAt,
          gradedBars,
          betBars,
          e,
          e0,
          threshold: LAB_THRESHOLD,
          meanX,
          meanB,
          currentB,
          latestBar,
        };
      })
    );

    const response: LabResponse = {
      version: LAB_VERSION,
      threshold: LAB_THRESHOLD,
      hypotheses,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('[signals/lab] read failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
