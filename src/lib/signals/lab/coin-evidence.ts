import { LAB_V3_UNIVERSE } from '@/lib/signals/lab/candidates';
import type {
  LabResponse,
  LabStatus,
  LabV2Response,
  LabV3Response,
  LabV4Response,
} from '@/lib/signals/lab/view';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';

export type CoinPosition =
  | { kind: 'not_in_universe' }
  | { kind: 'no_bar' }
  | { kind: 'cash' }
  | { kind: 'flat' }
  | { kind: 'long' | 'short'; weight?: number; until?: number };

export interface CoinEvidenceRow {
  lab: 'lab-v1' | 'lab-v2' | 'lab-v3' | 'lab-v4';
  id: string;
  candidate: string;
  timeframe: string;
  status: LabStatus;
  e: number;
  threshold: number;
  barClose: string | null;
  position: CoinPosition;
}

export function coinEvidence(
  symbol: string,
  labs: {
    v1?: LabResponse;
    v2?: LabV2Response;
    v3?: LabV3Response;
    v4?: LabV4Response;
  },
): CoinEvidenceRow[] {
  const inSignalSymbols = (SIGNAL_SYMBOLS as readonly string[]).includes(symbol);
  const inLabV3Universe = (LAB_V3_UNIVERSE as readonly string[]).includes(symbol);

  const rows: CoinEvidenceRow[] = [];

  // Lab-v4 (S1, S2)
  if (labs.v4?.hypotheses) {
    for (const hyp of labs.v4.hypotheses) {
      let position: CoinPosition;
      if (!inSignalSymbols) {
        position = { kind: 'not_in_universe' };
      } else if (!hyp.latestBar) {
        position = { kind: 'no_bar' };
      } else {
        const trade = hyp.openTrades?.find((t) => t.symbol === symbol);
        if (trade) {
          const until = new Date(trade.exitsAt).getTime();
          position = {
            kind: trade.side === 1 ? 'long' : 'short',
            ...(Number.isNaN(until) ? {} : { until }),
          };
        } else {
          position = { kind: 'flat' };
        }
      }
      rows.push({
        lab: 'lab-v4',
        id: hyp.id,
        candidate: hyp.candidate,
        timeframe: hyp.timeframe,
        status: hyp.status,
        e: hyp.e,
        threshold: hyp.threshold,
        barClose: hyp.latestBar?.barClose ?? null,
        position,
      });
    }
  }

  // Lab-v3 (F1)
  if (labs.v3?.hypotheses) {
    for (const hyp of labs.v3.hypotheses) {
      let position: CoinPosition;
      if (!inLabV3Universe) {
        position = { kind: 'not_in_universe' };
      } else if (!hyp.latestBar) {
        position = { kind: 'no_bar' };
      } else if (hyp.latestBar.cash) {
        position = { kind: 'cash' };
      } else if (hyp.latestBar.positions) {
        const pos = hyp.latestBar.positions.find((p) => p.symbol === symbol);
        if (pos && Math.abs(pos.weight) >= 0.0005) {
          position = {
            kind: pos.weight > 0 ? 'long' : 'short',
            weight: Math.abs(pos.weight),
          };
        } else {
          position = { kind: 'flat' };
        }
      } else {
        position = { kind: 'flat' };
      }
      rows.push({
        lab: 'lab-v3',
        id: hyp.id,
        candidate: hyp.candidate,
        timeframe: hyp.timeframe,
        status: hyp.status,
        e: hyp.e,
        threshold: hyp.threshold,
        barClose: hyp.latestBar?.barClose ?? null,
        position,
      });
    }
  }

  // Lab-v2 (N2, N3)
  if (labs.v2?.hypotheses) {
    for (const hyp of labs.v2.hypotheses) {
      let position: CoinPosition;
      if (!inSignalSymbols) {
        position = { kind: 'not_in_universe' };
      } else if (!hyp.latestBar) {
        position = { kind: 'no_bar' };
      } else if (hyp.latestBar.cash) {
        position = { kind: 'cash' };
      } else if (hyp.latestBar.positions) {
        const pos = hyp.latestBar.positions.find((p) => p.symbol === symbol);
        if (pos && Math.abs(pos.weight) >= 0.0005) {
          position = {
            kind: pos.weight > 0 ? 'long' : 'short',
            weight: Math.abs(pos.weight),
          };
        } else {
          position = { kind: 'flat' };
        }
      } else {
        position = { kind: 'flat' };
      }
      rows.push({
        lab: 'lab-v2',
        id: hyp.id,
        candidate: hyp.candidate,
        timeframe: hyp.timeframe,
        status: hyp.status,
        e: hyp.e,
        threshold: hyp.threshold,
        barClose: hyp.latestBar?.barClose ?? null,
        position,
      });
    }
  }

  // Lab-v1
  if (labs.v1?.hypotheses) {
    for (const hyp of labs.v1.hypotheses) {
      let position: CoinPosition;
      if (!inSignalSymbols) {
        position = { kind: 'not_in_universe' };
      } else if (!hyp.latestBar) {
        position = { kind: 'no_bar' };
      } else {
        position = { kind: 'flat' };
      }
      rows.push({
        lab: 'lab-v1',
        id: hyp.id,
        candidate: hyp.candidate,
        timeframe: hyp.timeframe,
        status: hyp.status,
        e: hyp.e,
        threshold: hyp.threshold,
        barClose: hyp.latestBar?.barClose ?? null,
        position,
      });
    }
  }

  // Sort rows by e / threshold, descending
  rows.sort((a, b) => {
    const ratioA = a.threshold > 0 ? a.e / a.threshold : 0;
    const ratioB = b.threshold > 0 ? b.e / b.threshold : 0;
    return ratioB - ratioA;
  });

  return rows;
}
