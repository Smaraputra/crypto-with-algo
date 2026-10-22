/**
 * Forward signal lab grading job for lab-v4 (S1-1h and S2-1h).
 *
 * Grades due bars in bar-close order once their 8-hour hold window has closed.
 * Each trade enters at T + D (10 min) and is held 8 hours.
 * Uses per-trade net return R_t with funding and fixed round-trip cost (0.0014).
 */

import {
  BinanceHttpError,
  type PerpKline,
} from '@/lib/binance-futures';
import {
  insertLabScoreOnce,
  LabScore,
  type LabScoreFields,
} from '@/lib/models/lab-score';
import { LabSignal, type ILabSignal } from '@/lib/models/lab-signal';
import { connectDB } from '@/lib/mongodb';
import {
  LAB_HYPOTHESES_V4,
} from '@/lib/signals/lab/candidates';
import {
  eValue,
  initialEState,
} from '@/lib/signals/lab/e-process';
import {
  defaultFundingSumsFor,
  defaultLabGradeDeps,
  type FundingSumsResult,
  LAB_GRADE_MAX_SPAN_MS,
  type LabGradeDeps,
  type LabGradeReport,
  normalizeFundingSumsResult,
} from '@/lib/signals/lab/job-grade';
import {
  gradeDueAtV4,
  gradeTradeBar,
  priceTimesV4,
  type TradeGradeInput,
} from '@/lib/signals/lab/v4/grade';

export type LabGradeV4Deps = LabGradeDeps & { sleep?: (ms: number) => Promise<void> };

export async function runLabGradeV4(
  now: number,
  deps?: LabGradeV4Deps
): Promise<LabGradeReport> {
  await connectDB();

  const d: LabGradeV4Deps = {
    fetchPerpKlinesRange: deps?.fetchPerpKlinesRange ?? defaultLabGradeDeps.fetchPerpKlinesRange,
    fundingSumsFor: deps?.fundingSumsFor ?? defaultLabGradeDeps.fundingSumsFor,
    syncFundingSettlements: deps?.syncFundingSettlements ?? defaultLabGradeDeps.syncFundingSettlements,
    fetchPerpExchangeInfo: deps?.fetchPerpExchangeInfo ?? defaultLabGradeDeps.fetchPerpExchangeInfo,
    sleep: deps?.sleep ?? defaultLabGradeDeps.sleep,
    clock: deps?.clock ?? defaultLabGradeDeps.clock,
  };

  const report: LabGradeReport = {
    success: true,
    graded: [],
    pending: [],
    errors: [],
  };

  interface DueV4HypothesisInfo {
    hyp: (typeof LAB_HYPOTHESES_V4)[number];
    dueSignals: ILabSignal[];
    last: LabScoreFields | null;
  }

  const dueV4ByHypothesis: DueV4HypothesisInfo[] = [];

  for (const hyp of LAB_HYPOTHESES_V4) {
    const last = (await LabScore.findOne({
      version: hyp.version,
      hypothesis: hyp.id,
    })
      .sort({ barClose: -1 })
      .lean()) as LabScoreFields | null;

    const minBarClose = last?.barClose ?? -1;
    const signals = (await LabSignal.find({
      version: hyp.version,
      hypothesis: hyp.id,
      barClose: { $gt: minBarClose },
    })
      .sort({ barClose: 1 })
      .lean()) as ILabSignal[];

    const dueSignals: ILabSignal[] = [];
    for (const sig of signals) {
      const dueAt = gradeDueAtV4(sig.barClose);
      if (now < dueAt) {
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt,
        });
        break;
      }
      if (
        dueSignals.length > 0 &&
        sig.barClose - dueSignals[0].barClose > LAB_GRADE_MAX_SPAN_MS
      ) {
        break;
      }
      dueSignals.push(sig);
    }

    if (dueSignals.length > 0) {
      dueV4ByHypothesis.push({ hyp, dueSignals, last });
    }
  }

  if (dueV4ByHypothesis.length === 0) {
    return report;
  }

  const neededTimesBySymbol = new Map<string, Set<number>>();
  for (const { dueSignals } of dueV4ByHypothesis) {
    for (const sig of dueSignals) {
      const { start, end } = priceTimesV4(sig.barClose);
      for (const [sym, side] of Object.entries(sig.scores)) {
        if (side !== 0 && Number.isFinite(side)) {
          let set = neededTimesBySymbol.get(sym);
          if (!set) {
            set = new Set<number>();
            neededTimesBySymbol.set(sym, set);
          }
          set.add(start);
          set.add(end);
        }
      }
    }
  }

  const symbolsV4 = Array.from(neededTimesBySymbol.keys()).sort();
  const priceMapBySymbol = new Map<string, Map<number, number>>();
  const sleep = d.sleep ?? defaultLabGradeDeps.sleep!;

  for (let i = 0; i < symbolsV4.length; i++) {
    if (i > 0) {
      await sleep(250);
    }
    const sym = symbolsV4[i];
    const times = Array.from(neededTimesBySymbol.get(sym)!);
    const minNeeded = Math.min(...times);
    const maxNeeded = Math.max(...times);

    let klines: PerpKline[];
    try {
      klines = await d.fetchPerpKlinesRange(sym, '5m', minNeeded, maxNeeded);
    } catch (err) {
      if (err instanceof BinanceHttpError && err.status === 400) {
        report.errors.push(err.message);
        klines = [];
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(msg);
        report.success = false;
        return report;
      }
    }

    const klineMap = new Map<number, number>();
    for (const k of klines) {
      klineMap.set(k.openTime, k.open);
    }
    priceMapBySymbol.set(sym, klineMap);
  }

  const syncErrorsBySymbol = new Map<string, string>();
  const shouldSyncFunding =
    symbolsV4.length > 0 &&
    (deps?.syncFundingSettlements !== undefined || !deps?.fundingSumsFor) &&
    Boolean(d.syncFundingSettlements);

  if (shouldSyncFunding && d.syncFundingSettlements) {
    try {
      const syncResults = await d.syncFundingSettlements(symbolsV4, now);
      if (Array.isArray(syncResults)) {
        for (const res of syncResults) {
          if (res && typeof res === 'object' && 'symbol' in res && res.error) {
            syncErrorsBySymbol.set(res.symbol, res.error);
            report.errors.push(`Funding sync error for ${res.symbol}: ${res.error}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report.errors.push(msg);
      for (const sym of symbolsV4) {
        syncErrorsBySymbol.set(sym, msg);
      }
    }
  }

  const fundingSumsFor = d.fundingSumsFor ?? defaultFundingSumsFor;

  for (const { hyp, dueSignals, last } of dueV4ByHypothesis) {
    let currentState = last?.state ? { ...last.state } : initialEState();

    for (const sig of dueSignals) {
      const { start, end } = priceTimesV4(sig.barClose);
      const prices: Record<string, { start: number; end: number }> = {};
      const pricedCoins: string[] = [];

      for (const [sym, side] of Object.entries(sig.scores)) {
        if (!Number.isFinite(side) || side === 0) continue;

        const klineMap = priceMapBySymbol.get(sym);
        const hasStart = klineMap ? klineMap.has(start) : false;
        const hasEnd = klineMap ? klineMap.has(end) : false;

        if (hasStart && hasEnd) {
          prices[sym] = {
            start: klineMap!.get(start)!,
            end: klineMap!.get(end)!,
          };
          pricedCoins.push(sym);
        }
      }

      pricedCoins.sort();

      const hasSyncError = pricedCoins.some((sym) => syncErrorsBySymbol.has(sym));
      if (hasSyncError) {
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt: gradeDueAtV4(sig.barClose),
        });
        break;
      }

      let fundingSums: Record<string, number> = {};

      if (pricedCoins.length > 0) {
        let fundingRaw: FundingSumsResult | Record<string, number>;
        try {
          fundingRaw = await fundingSumsFor(pricedCoins, start, end);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          report.errors.push(msg);
          report.pending.push({
            hypothesis: hyp.id,
            barClose: sig.barClose,
            dueAt: gradeDueAtV4(sig.barClose),
          });
          break;
        }

        const norm = normalizeFundingSumsResult(fundingRaw);
        fundingSums = norm.sums;

        const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
        let coverageMissing = false;
        for (const sym of pricedCoins) {
          if (!norm.coverage[sym]) {
            coverageMissing = true;
            if (now > end + FORTY_EIGHT_HOURS) {
              report.errors.push(
                `Funding coverage gap older than 48 hours for ${sym} at windowEnd ${end} in hypothesis ${hyp.id}`
              );
            }
          }
        }

        if (coverageMissing) {
          report.pending.push({
            hypothesis: hyp.id,
            barClose: sig.barClose,
            dueAt: gradeDueAtV4(sig.barClose),
          });
          break;
        }
      }

      const input: TradeGradeInput = {
        hypothesis: hyp,
        barClose: sig.barClose,
        late: sig.late,
        scores: sig.scores,
        prices,
        fundingSums,
        prev: {
          state: currentState,
        },
        gradedAt: new Date(d.clock()),
      };

      let row: LabScoreFields;
      try {
        row = gradeTradeBar(input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(msg);
        report.pending.push({
          hypothesis: hyp.id,
          barClose: sig.barClose,
          dueAt: gradeDueAtV4(sig.barClose),
        });
        break;
      }

      const { inserted } = await insertLabScoreOnce(row);
      if (!inserted) {
        break;
      }

      currentState = row.state;

      report.graded.push({
        hypothesis: hyp.id,
        barClose: sig.barClose,
        bet: row.bet,
        x: row.x,
        b: row.b,
        e: eValue(row.state),
      });
    }
  }

  return report;
}
