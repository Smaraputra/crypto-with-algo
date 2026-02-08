import type { Transaction } from '@/types/portfolio';
import type { RealizedGain } from '@/types/analytics';

interface CsvTransaction {
  date: Date;
  type: 'buy' | 'sell';
  symbol: string;
  quantity: number;
  price: number;
  fee: number;
  proceeds?: number;
  costBasis?: number;
  gain?: number;
  holdingPeriod?: 'short-term' | 'long-term';
}

const CSV_HEADER =
  'Date,Type,Asset,Quantity,Price (USD),Fee (USD),Proceeds (USD),Cost Basis (USD),Gain/Loss (USD),Holding Period';

function escapeField(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function formatDate(date: Date): string {
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

function formatNumber(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function stripQuoteAsset(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

/**
 * Build CSV rows from buy transactions and realized gains for a single holding.
 */
export function buildCsvRows(
  transactions: Transaction[],
  realizedGains: RealizedGain[],
  symbol: string,
  year?: number
): CsvTransaction[] {
  const rows: CsvTransaction[] = [];

  for (const tx of transactions) {
    if (tx.type === 'buy') {
      const txDate = new Date(tx.date);
      if (year && txDate.getFullYear() !== year) continue;
      rows.push({
        date: txDate,
        type: 'buy',
        symbol,
        quantity: tx.quantity,
        price: tx.price,
        fee: tx.fee ?? 0,
      });
    }
  }

  for (const gain of realizedGains) {
    const sellDate = new Date(gain.sellDate);
    if (year && sellDate.getFullYear() !== year) continue;
    rows.push({
      date: sellDate,
      type: 'sell',
      symbol,
      quantity: gain.quantity,
      price: gain.proceeds / gain.quantity,
      fee: 0,
      proceeds: gain.proceeds,
      costBasis: gain.costBasis,
      gain: gain.gain,
      holdingPeriod: gain.holdingPeriod,
    });
  }

  return rows;
}

/**
 * Generate a full CSV string from multiple holdings' transactions and realized gains.
 */
export function generateTaxCsv(
  holdingsData: Array<{
    symbol: string;
    transactions: Transaction[];
    realizedGains: RealizedGain[];
  }>,
  year?: number
): string {
  const allRows: CsvTransaction[] = [];

  for (const holding of holdingsData) {
    const rows = buildCsvRows(
      holding.transactions,
      holding.realizedGains,
      holding.symbol,
      year
    );
    allRows.push(...rows);
  }

  allRows.sort((a, b) => a.date.getTime() - b.date.getTime());

  const lines = allRows.map((row) => {
    const fields = [
      escapeField(formatDate(row.date)),
      escapeField(row.type === 'buy' ? 'Buy' : 'Sell'),
      escapeField(stripQuoteAsset(row.symbol)),
      escapeField(formatNumber(row.quantity, row.quantity < 1 ? 8 : 4)),
      escapeField(formatNumber(row.price, 2)),
      escapeField(formatNumber(row.fee, 2)),
      row.proceeds !== undefined ? escapeField(formatNumber(row.proceeds, 2)) : '',
      row.costBasis !== undefined ? escapeField(formatNumber(row.costBasis, 2)) : '',
      row.gain !== undefined ? escapeField(formatNumber(row.gain, 2)) : '',
      row.holdingPeriod ? escapeField(row.holdingPeriod === 'long-term' ? 'Long-term' : 'Short-term') : '',
    ];
    return fields.join(',');
  });

  return [CSV_HEADER, ...lines].join('\n');
}
