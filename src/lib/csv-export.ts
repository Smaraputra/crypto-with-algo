import type { Transaction } from '@/types/portfolio';
import type { RealizedGain } from '@/types/analytics';
import type { CsvFormat } from '@/types/analytics';

export interface CsvTransaction {
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

interface CsvAdapter {
  header: string;
  buildRow(row: CsvTransaction): string;
}

export function escapeField(value: string | number): string {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function formatDate(date: Date): string {
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

function formatDateUTC(date: Date): string {
  const d = new Date(date);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function formatNumber(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

export function stripQuoteAsset(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

function quantityStr(qty: number): string {
  return formatNumber(qty, qty < 1 ? 8 : 4);
}

const genericAdapter: CsvAdapter = {
  header:
    'Date,Type,Asset,Quantity,Price (USD),Fee (USD),Proceeds (USD),Cost Basis (USD),Gain/Loss (USD),Holding Period',
  buildRow(row: CsvTransaction): string {
    const fields = [
      escapeField(formatDate(row.date)),
      escapeField(row.type === 'buy' ? 'Buy' : 'Sell'),
      escapeField(stripQuoteAsset(row.symbol)),
      escapeField(quantityStr(row.quantity)),
      escapeField(formatNumber(row.price, 2)),
      escapeField(formatNumber(row.fee, 2)),
      row.proceeds !== undefined ? escapeField(formatNumber(row.proceeds, 2)) : '',
      row.costBasis !== undefined ? escapeField(formatNumber(row.costBasis, 2)) : '',
      row.gain !== undefined ? escapeField(formatNumber(row.gain, 2)) : '',
      row.holdingPeriod
        ? escapeField(row.holdingPeriod === 'long-term' ? 'Long-term' : 'Short-term')
        : '',
    ];
    return fields.join(',');
  },
};

const koinlyAdapter: CsvAdapter = {
  header:
    'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Label',
  buildRow(row: CsvTransaction): string {
    const asset = stripQuoteAsset(row.symbol);
    if (row.type === 'buy') {
      // Buying crypto: sent USD, received crypto
      const totalCost = row.quantity * row.price + row.fee;
      return [
        escapeField(formatDateUTC(row.date)),
        escapeField(formatNumber(totalCost, 2)),
        'USD',
        escapeField(quantityStr(row.quantity)),
        escapeField(asset),
        row.fee > 0 ? escapeField(formatNumber(row.fee, 2)) : '',
        row.fee > 0 ? 'USD' : '',
        '',
      ].join(',');
    }
    // Selling crypto: sent crypto, received USD
    const received = row.proceeds ?? row.quantity * row.price;
    return [
      escapeField(formatDateUTC(row.date)),
      escapeField(quantityStr(row.quantity)),
      escapeField(asset),
      escapeField(formatNumber(received, 2)),
      'USD',
      row.fee > 0 ? escapeField(formatNumber(row.fee, 2)) : '',
      row.fee > 0 ? 'USD' : '',
      '',
    ].join(',');
  },
};

const cointrackerAdapter: CsvAdapter = {
  header:
    'Date,Type,Buy/In Amount,Buy/In Currency,Sell/Out Amount,Sell/Out Currency,Fee,Fee Currency',
  buildRow(row: CsvTransaction): string {
    const asset = stripQuoteAsset(row.symbol);
    if (row.type === 'buy') {
      return [
        escapeField(formatDate(row.date)),
        'Buy',
        escapeField(quantityStr(row.quantity)),
        escapeField(asset),
        escapeField(formatNumber(row.quantity * row.price, 2)),
        'USD',
        row.fee > 0 ? escapeField(formatNumber(row.fee, 2)) : '',
        row.fee > 0 ? 'USD' : '',
      ].join(',');
    }
    const sellAmount = row.proceeds ?? row.quantity * row.price;
    return [
      escapeField(formatDate(row.date)),
      'Sell',
      escapeField(formatNumber(sellAmount, 2)),
      'USD',
      escapeField(quantityStr(row.quantity)),
      escapeField(asset),
      row.fee > 0 ? escapeField(formatNumber(row.fee, 2)) : '',
      row.fee > 0 ? 'USD' : '',
    ].join(',');
  },
};

const ADAPTERS: Record<CsvFormat, CsvAdapter> = {
  generic: genericAdapter,
  koinly: koinlyAdapter,
  cointracker: cointrackerAdapter,
};

export function getAdapter(format: CsvFormat): CsvAdapter {
  return ADAPTERS[format];
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
  year?: number,
  format: CsvFormat = 'generic'
): string {
  const adapter = getAdapter(format);
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

  const lines = allRows.map((row) => adapter.buildRow(row));

  return [adapter.header, ...lines].join('\n');
}
