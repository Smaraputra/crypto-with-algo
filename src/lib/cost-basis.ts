import type { Transaction } from '@/types/portfolio';
import type { TaxLot, RealizedGain, CostBasisHolding, CostBasisMethod } from '@/types/analytics';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface CostBasisComputeResult {
  openLots: TaxLot[];
  realizedGains: RealizedGain[];
  totalRealizedGain: number;
  totalUnrealizedCostBasis: number;
}

/** @deprecated Use CostBasisComputeResult instead */
export type FIFOResult = CostBasisComputeResult;

type LotSelector = (lots: TaxLot[]) => TaxLot | undefined;

function selectFIFO(lots: TaxLot[]): TaxLot | undefined {
  return lots.find((l) => l.remainingQuantity > 0);
}

function selectLIFO(lots: TaxLot[]): TaxLot | undefined {
  return lots.findLast((l) => l.remainingQuantity > 0);
}

function selectHIFO(lots: TaxLot[]): TaxLot | undefined {
  let best: TaxLot | undefined;
  for (const lot of lots) {
    if (lot.remainingQuantity > 0 && (!best || lot.pricePerUnit > best.pricePerUnit)) {
      best = lot;
    }
  }
  return best;
}

const LOT_SELECTORS: Record<CostBasisMethod, LotSelector> = {
  fifo: selectFIFO,
  lifo: selectLIFO,
  hifo: selectHIFO,
};

export function computeCostBasis(
  method: CostBasisMethod,
  transactions: Transaction[],
  symbol: string
): CostBasisComputeResult {
  if (transactions.length === 0) {
    return {
      openLots: [],
      realizedGains: [],
      totalRealizedGain: 0,
      totalUnrealizedCostBasis: 0,
    };
  }

  const selectLot = LOT_SELECTORS[method];

  const sorted = [...transactions].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const lots: TaxLot[] = [];
  const gains: RealizedGain[] = [];

  for (const tx of sorted) {
    if (tx.quantity <= 0) continue;

    if (tx.type === 'buy') {
      const fee = tx.fee ?? 0;
      const costPerUnit = tx.price + fee / tx.quantity;
      lots.push({
        date: new Date(tx.date),
        quantity: tx.quantity,
        pricePerUnit: costPerUnit,
        fee,
        remainingQuantity: tx.quantity,
      });
    } else {
      let remaining = tx.quantity;
      const sellFee = tx.fee ?? 0;
      const sellDate = new Date(tx.date);

      while (remaining > 0 && lots.length > 0) {
        const selected = selectLot(lots);
        if (!selected) break;

        const depleted = Math.min(remaining, selected.remainingQuantity);
        const proceeds = depleted * tx.price;
        const feeShare = (depleted / tx.quantity) * sellFee;
        const adjustedProceeds = proceeds - feeShare;
        const costBasis = depleted * selected.pricePerUnit;
        const holdingMs = sellDate.getTime() - selected.date.getTime();

        gains.push({
          sellDate,
          buyDate: selected.date,
          quantity: depleted,
          proceeds: adjustedProceeds,
          costBasis,
          gain: adjustedProceeds - costBasis,
          holdingPeriod: holdingMs > ONE_YEAR_MS ? 'long-term' : 'short-term',
          symbol,
        });

        selected.remainingQuantity -= depleted;
        remaining -= depleted;

        if (selected.remainingQuantity <= 0) {
          const idx = lots.indexOf(selected);
          lots.splice(idx, 1);
        }
      }
    }
  }

  const openLots = lots.filter((l) => l.remainingQuantity > 0);
  const totalRealizedGain = gains.reduce((sum, g) => sum + g.gain, 0);
  const totalUnrealizedCostBasis = openLots.reduce(
    (sum, l) => sum + l.remainingQuantity * l.pricePerUnit,
    0
  );

  return {
    openLots,
    realizedGains: gains,
    totalRealizedGain,
    totalUnrealizedCostBasis,
  };
}

/** Backward-compatible wrapper: computes cost basis using FIFO */
export function computeFIFO(
  transactions: Transaction[],
  symbol: string
): CostBasisComputeResult {
  return computeCostBasis('fifo', transactions, symbol);
}

export function computeHoldingCostBasis(
  transactions: Transaction[],
  symbol: string,
  method: CostBasisMethod = 'fifo'
): CostBasisHolding {
  const result = computeCostBasis(method, transactions, symbol);
  const totalQuantity = result.openLots.reduce(
    (sum, l) => sum + l.remainingQuantity,
    0
  );
  const averageCost =
    totalQuantity > 0 ? result.totalUnrealizedCostBasis / totalQuantity : 0;

  return {
    symbol,
    totalQuantity,
    averageCost,
    totalCost: result.totalUnrealizedCostBasis,
    openLots: result.openLots,
    realizedGains: result.realizedGains,
    totalRealizedGain: result.totalRealizedGain,
  };
}
