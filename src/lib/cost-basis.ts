import type { Transaction } from '@/types/portfolio';
import type { TaxLot, RealizedGain, CostBasisHolding } from '@/types/analytics';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface FIFOResult {
  openLots: TaxLot[];
  realizedGains: RealizedGain[];
  totalRealizedGain: number;
  totalUnrealizedCostBasis: number;
}

export function computeFIFO(
  transactions: Transaction[],
  symbol: string
): FIFOResult {
  if (transactions.length === 0) {
    return {
      openLots: [],
      realizedGains: [],
      totalRealizedGain: 0,
      totalUnrealizedCostBasis: 0,
    };
  }

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
        const oldest = lots.find((l) => l.remainingQuantity > 0);
        if (!oldest) break;

        const depleted = Math.min(remaining, oldest.remainingQuantity);
        const proceeds = depleted * tx.price;
        const feeShare = (depleted / tx.quantity) * sellFee;
        const adjustedProceeds = proceeds - feeShare;
        const costBasis = depleted * oldest.pricePerUnit;
        const holdingMs = sellDate.getTime() - oldest.date.getTime();

        gains.push({
          sellDate,
          buyDate: oldest.date,
          quantity: depleted,
          proceeds: adjustedProceeds,
          costBasis,
          gain: adjustedProceeds - costBasis,
          holdingPeriod: holdingMs > ONE_YEAR_MS ? 'long-term' : 'short-term',
          symbol,
        });

        oldest.remainingQuantity -= depleted;
        remaining -= depleted;

        if (oldest.remainingQuantity <= 0) {
          const idx = lots.indexOf(oldest);
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

export function computeHoldingCostBasis(
  transactions: Transaction[],
  symbol: string
): CostBasisHolding {
  const result = computeFIFO(transactions, symbol);
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
