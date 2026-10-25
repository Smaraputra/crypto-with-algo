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
import { FundingSettlement } from '@/lib/models/funding-settlement';
import {
  insertLabScoreOnce,
  LabScore,
  type LabScoreFields,
} from '@/lib/models/lab-score';
import { LabSignal, type ILabSignal } from '@/lib/models/lab-signal';
import { connectDB } from '@/lib/mongodb';
import {
  LAB_HYPOTHESES_V4,
  LAB_HYPOTHESES_V4_DAILY,
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
  LAB_GRADE_SETTLE_MS,
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
import {
  gradeDailyBar,
  type DailyTrade,
} from '@/lib/signals/lab/v4/grade-daily';

export const LAB_V4_DAILY_START_MS: number | null = null;

export type LabGradeV4Deps = LabGradeDeps & {
  sleep?: (ms: number) => Promise<void>;
  dailyStartMs?: number | null;
};

const DAY_MS = 86_400_000;
const FUNDING_MATCH_TOLERANCE_MS = 60_000;
const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

type StoredSettlement = { symbol: string; rate: number; fundingTime: number };

/**
 * The settlement times a trade needs on day d: the coin's grid (every intervalHours from 00:00 UTC)
 * inside (max(entry, dayStart), min(exit, dayEnd)].
 */
function neededFundingTimes(
  trade: DailyTrade,
  dayStart: number,
  dayEnd: number,
  intervalHours: number
): number[] {
  const stepMs = intervalHours * 3600_000;
  const lo = Math.max(trade.entryTime, dayStart);
  const hi = Math.min(trade.exitTime, dayEnd);
  const times: number[] = [];
  for (let t = (Math.floor(lo / stepMs) + 1) * stepMs; t <= hi; t += stepMs) {
    times.push(t);
  }
  return times;
}

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
    dailyStartMs: deps?.dailyStartMs,
  };

  const report: LabGradeReport = {
    success: true,
    graded: [],
    pending: [],
    errors: [],
  };

  const sleep = d.sleep ?? defaultLabGradeDeps.sleep ?? (async () => {});
  const fundingSumsFor = d.fundingSumsFor ?? defaultFundingSumsFor;

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

    if (dueSignals.length === 0) {
      continue;
    }

    const neededTimesBySymbol = new Map<string, Set<number>>();
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

    const symbolsV4 = Array.from(neededTimesBySymbol.keys()).sort();
    const priceMapBySymbol = new Map<string, Map<number, number>>();
    let fetchErrorOccurred = false;

    for (let i = 0; i < symbolsV4.length; i++) {
      if (i > 0) {
        await sleep(250);
      }
      const sym = symbolsV4[i];
      const times = Array.from(neededTimesBySymbol.get(sym) ?? []);
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
          fetchErrorOccurred = true;
          break;
        }
      }

      const klineMap = new Map<number, number>();
      for (const k of klines) {
        klineMap.set(k.openTime, k.open);
      }
      priceMapBySymbol.set(sym, klineMap);
    }

    if (fetchErrorOccurred) {
      continue;
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

    let currentState = last?.state ? { ...last.state } : initialEState();

    for (const sig of dueSignals) {
      const { start, end } = priceTimesV4(sig.barClose);
      const prices: Record<string, { start: number; end: number }> = {};
      const pricedCoins: string[] = [];

      for (const [sym, side] of Object.entries(sig.scores)) {
        if (!Number.isFinite(side) || side === 0) continue;

        const klineMap = priceMapBySymbol.get(sym);
        const pStart = klineMap?.get(start);
        const pEnd = klineMap?.get(end);

        if (typeof pStart === 'number' && typeof pEnd === 'number') {
          prices[sym] = {
            start: pStart,
            end: pEnd,
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

  const dailyStartMs = deps?.dailyStartMs !== undefined ? deps.dailyStartMs : LAB_V4_DAILY_START_MS;
  if (dailyStartMs !== null && dailyStartMs % DAY_MS !== 0) {
    report.errors.push(`Daily pass start is not a UTC midnight: ${dailyStartMs}`);
  } else if (dailyStartMs !== null) {
    const SEVENTY_TWO_HOURS = 72 * 3600_000;

    for (const cand of ['S1', 'S2'] as const) {
      const dailyHypId = `${cand}-1h-daily`;
      try {
        const sigHypId = `${cand}-1h`;
        const hypConfig = LAB_HYPOTHESES_V4_DAILY.find((h) => h.id === dailyHypId);
        if (!hypConfig) continue;

        const lastDaily = (await LabScore.findOne({
          version: 'lab-v4',
          hypothesis: dailyHypId,
        })
          .sort({ barClose: -1 })
          .lean()) as LabScoreFields | null;

        let dayStart = lastDaily ? lastDaily.barClose + 86_400_000 : dailyStartMs;
        let currentState = lastDaily?.state ? { ...lastDaily.state } : initialEState();

        while (now >= dayStart + 86_400_000 + LAB_GRADE_SETTLE_MS) {
          const dayEnd = dayStart + 86_400_000;

          const signals = (await LabSignal.find({
            version: 'lab-v4',
            hypothesis: sigHypId,
            barClose: {
              $gte: dayStart - 9 * 3600_000,
              $lte: dayEnd,
            },
            late: false,
          })
            .sort({ barClose: 1 })
            .lean()) as ILabSignal[];

          const trades: DailyTrade[] = [];
          for (const sig of signals) {
            const entryTime = sig.barClose + 10 * 60_000;
            const exitTime = entryTime + 8 * 3600_000;
            if (entryTime < dayEnd && exitTime > dayStart) {
              if (sig.scores && typeof sig.scores === 'object') {
                const sortedEntries = Object.entries(sig.scores).sort(([a], [b]) => a.localeCompare(b));
                for (const [sym, side] of sortedEntries) {
                  if (side === 1 || side === -1) {
                    trades.push({
                      symbol: sym,
                      side,
                      entryTime,
                      exitTime,
                      barClose: sig.barClose,
                    });
                  }
                }
              }
            }
          }

          trades.sort((a, b) => a.entryTime - b.entryTime || a.symbol.localeCompare(b.symbol));

          if (trades.length === 0) {
            const row = gradeDailyBar({
              hypothesis: hypConfig,
              dayStart,
              trades: [],
              prices5m: {},
              settlements: [],
              prev: { state: currentState },
              gradedAt: new Date(d.clock()),
            });

            const { inserted } = await insertLabScoreOnce(row);
            if (!inserted) {
              break;
            }

            currentState = row.state;
            report.graded.push({
              hypothesis: dailyHypId,
              barClose: dayStart,
              bet: row.bet,
              x: row.x,
              b: row.b,
              e: eValue(row.state),
            });

            dayStart += 86_400_000;
            continue;
          }

          const neededTimesBySymbol = new Map<string, Set<number>>();
          for (const t of trades) {
            let times = neededTimesBySymbol.get(t.symbol);
            if (!times) {
              times = new Set<number>();
              neededTimesBySymbol.set(t.symbol, times);
            }
            const isEntryInDay = t.entryTime >= dayStart && t.entryTime < dayEnd;
            const startTime = isEntryInDay ? t.entryTime : dayStart;
            const isExitInDay = t.exitTime > dayStart && t.exitTime <= dayEnd;
            const endTime = isExitInDay ? t.exitTime : dayEnd;
            times.add(startTime);
            times.add(endTime);
          }

          const symbolsDaily = Array.from(neededTimesBySymbol.keys()).sort();
          const priceMapBySymbol = new Map<string, Map<number, number>>();

          for (let i = 0; i < symbolsDaily.length; i++) {
            if (i > 0) {
              await sleep(250);
            }
            const sym = symbolsDaily[i];
            const times = Array.from(neededTimesBySymbol.get(sym) ?? []);
            const minNeeded = Math.min(...times);
            const maxNeeded = Math.max(...times);

            let klines: PerpKline[];
            try {
              klines = await d.fetchPerpKlinesRange(sym, '5m', minNeeded, maxNeeded);
            } catch (err) {
              if (err instanceof BinanceHttpError && err.status === 400) {
                klines = [];
              } else {
                throw err;
              }
            }

            const klineMap = new Map<number, number>();
            for (const k of klines) {
              klineMap.set(k.openTime, k.open);
            }
            priceMapBySymbol.set(sym, klineMap);
          }

          let missingPrice = false;
          for (const t of trades) {
            const kMap = priceMapBySymbol.get(t.symbol);
            const isEntryInDay = t.entryTime >= dayStart && t.entryTime < dayEnd;
            const startTime = isEntryInDay ? t.entryTime : dayStart;
            const isExitInDay = t.exitTime > dayStart && t.exitTime <= dayEnd;
            const endTime = isExitInDay ? t.exitTime : dayEnd;

            const startPrice = kMap?.get(startTime);
            const endPrice = kMap?.get(endTime);
            if (
              typeof startPrice !== 'number' ||
              !Number.isFinite(startPrice) ||
              startPrice <= 0 ||
              typeof endPrice !== 'number' ||
              !Number.isFinite(endPrice) ||
              endPrice <= 0
            ) {
              missingPrice = true;
              break;
            }
          }

          if (missingPrice) {
            report.pending.push({
              hypothesis: dailyHypId,
              barClose: dayStart,
              dueAt: dayEnd + LAB_GRADE_SETTLE_MS,
            });
            break;
          }

          if (d.syncFundingSettlements) {
            try {
              await d.syncFundingSettlements(symbolsDaily, now);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              report.errors.push(`Daily funding sync error (${dailyHypId}): ${msg}`);
            }
          }

          const settlements = (await FundingSettlement.find(
            {
              symbol: { $in: symbolsDaily },
              fundingTime: {
                $gt: dayStart - FUNDING_MATCH_TOLERANCE_MS,
                $lte: dayEnd + FUNDING_MATCH_TOLERANCE_MS,
              },
            },
            { symbol: 1, rate: 1, fundingTime: 1, intervalHours: 1 }
          ).lean()) as Array<StoredSettlement & { intervalHours?: number | null }>;

          const intervalBySymbol = new Map<string, number>();
          for (const sym of symbolsDaily) {
            const latest = (await FundingSettlement.findOne(
              { symbol: sym, fundingTime: { $lte: dayEnd } },
              { intervalHours: 1 }
            )
              .sort({ fundingTime: -1 })
              .lean()) as { intervalHours?: number | null } | null;
            const hours = latest?.intervalHours;
            intervalBySymbol.set(
              sym,
              typeof hours === 'number' && Number.isFinite(hours) && hours > 0
                ? hours
                : DEFAULT_FUNDING_INTERVAL_HOURS
            );
          }

          const missingTimes = new Set<string>();
          for (const t of trades) {
            const interval = intervalBySymbol.get(t.symbol) ?? DEFAULT_FUNDING_INTERVAL_HOURS;
            for (const needed of neededFundingTimes(t, dayStart, dayEnd, interval)) {
              const present = settlements.some(
                (s) =>
                  s.symbol === t.symbol &&
                  Math.abs(s.fundingTime - needed) <= FUNDING_MATCH_TOLERANCE_MS
              );
              if (!present) {
                missingTimes.add(`${t.symbol}@${needed}`);
              }
            }
          }

          if (missingTimes.size > 0 && now < dayEnd + SEVENTY_TWO_HOURS) {
            report.pending.push({
              hypothesis: dailyHypId,
              barClose: dayStart,
              dueAt: dayEnd + SEVENTY_TWO_HOURS,
            });
            break;
          }

          const fundingGaps = Array.from(missingTimes).sort();

          const pricesRecord: Record<string, Record<number, number>> = {};
          for (const [sym, kMap] of priceMapBySymbol.entries()) {
            pricesRecord[sym] = {};
            for (const [time, open] of kMap.entries()) {
              pricesRecord[sym][time] = open;
            }
          }

          const row = gradeDailyBar({
            hypothesis: hypConfig,
            dayStart,
            trades,
            prices5m: pricesRecord,
            settlements,
            fundingGaps: fundingGaps.length > 0 ? fundingGaps : null,
            prev: { state: currentState },
            gradedAt: new Date(d.clock()),
          });

          const { inserted } = await insertLabScoreOnce(row);
          if (!inserted) {
            break;
          }

          currentState = row.state;
          report.graded.push({
            hypothesis: dailyHypId,
            barClose: dayStart,
            bet: row.bet,
            x: row.x,
            b: row.b,
            e: eValue(row.state),
          });

          dayStart += 86_400_000;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        report.errors.push(`Daily pass error (${dailyHypId}): ${msg}`);
      }
    }
  }

  return report;
}
