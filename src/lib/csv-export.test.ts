import { describe, it, expect } from 'vitest';
import { buildCsvRows, generateTaxCsv } from './csv-export';
import type { Transaction } from '@/types/portfolio';
import type { RealizedGain } from '@/types/analytics';

const buyTx: Transaction = {
  type: 'buy',
  quantity: 0.5,
  price: 42000,
  date: new Date('2024-01-15'),
  fee: 10,
};

const buyTx2: Transaction = {
  type: 'buy',
  quantity: 0.3,
  price: 45000,
  date: new Date('2024-03-10'),
  fee: 5,
};

const sellTx: Transaction = {
  type: 'sell',
  quantity: 0.3,
  price: 65000,
  date: new Date('2024-06-15'),
  fee: 15,
};

const gain: RealizedGain = {
  sellDate: new Date('2024-06-15'),
  buyDate: new Date('2024-01-15'),
  quantity: 0.3,
  proceeds: 19485,
  costBasis: 12606,
  gain: 6879,
  holdingPeriod: 'short-term',
  symbol: 'BTCUSDT',
};

const longTermGain: RealizedGain = {
  sellDate: new Date('2025-06-15'),
  buyDate: new Date('2024-01-15'),
  quantity: 0.2,
  proceeds: 14000,
  costBasis: 8404,
  gain: 5596,
  holdingPeriod: 'long-term',
  symbol: 'BTCUSDT',
};

describe('csv-export', () => {
  describe('buildCsvRows', () => {
    it('includes buy transactions as rows', () => {
      const rows = buildCsvRows([buyTx], [], 'BTCUSDT');
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('buy');
      expect(rows[0].quantity).toBe(0.5);
      expect(rows[0].price).toBe(42000);
      expect(rows[0].fee).toBe(10);
    });

    it('includes realized gains as sell rows', () => {
      const rows = buildCsvRows([sellTx], [gain], 'BTCUSDT');
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('sell');
      expect(rows[0].proceeds).toBe(19485);
      expect(rows[0].costBasis).toBe(12606);
      expect(rows[0].gain).toBe(6879);
      expect(rows[0].holdingPeriod).toBe('short-term');
    });

    it('filters by year', () => {
      const rows = buildCsvRows([buyTx, buyTx2], [gain], 'BTCUSDT', 2025);
      expect(rows).toHaveLength(0);
    });

    it('includes matching year only', () => {
      const rows = buildCsvRows([buyTx], [gain], 'BTCUSDT', 2024);
      expect(rows).toHaveLength(2); // buy + sell from gain
    });

    it('handles missing fee gracefully', () => {
      const noFeeTx: Transaction = { ...buyTx, fee: undefined };
      const rows = buildCsvRows([noFeeTx], [], 'BTCUSDT');
      expect(rows[0].fee).toBe(0);
    });

    it('returns empty for no matching data', () => {
      const rows = buildCsvRows([], [], 'BTCUSDT');
      expect(rows).toHaveLength(0);
    });
  });

  describe('generateTaxCsv', () => {
    it('generates CSV with correct header', () => {
      const csv = generateTaxCsv([]);
      expect(csv).toBe(
        'Date,Type,Asset,Quantity,Price (USD),Fee (USD),Proceeds (USD),Cost Basis (USD),Gain/Loss (USD),Holding Period'
      );
    });

    it('generates CSV with buy and sell rows', () => {
      const csv = generateTaxCsv([
        {
          symbol: 'BTCUSDT',
          transactions: [buyTx],
          realizedGains: [gain],
        },
      ]);

      const lines = csv.split('\n');
      expect(lines).toHaveLength(3); // header + buy + sell
      expect(lines[0]).toContain('Date,Type,Asset');

      // Buy row
      expect(lines[1]).toContain('2024-01-15');
      expect(lines[1]).toContain('Buy');
      expect(lines[1]).toContain('BTC');

      // Sell row
      expect(lines[2]).toContain('2024-06-15');
      expect(lines[2]).toContain('Sell');
      expect(lines[2]).toContain('Short-term');
    });

    it('sorts rows by date across multiple holdings', () => {
      const ethBuy: Transaction = {
        type: 'buy',
        quantity: 5,
        price: 2200,
        date: new Date('2024-02-01'),
        fee: 2,
      };

      const csv = generateTaxCsv([
        { symbol: 'BTCUSDT', transactions: [buyTx], realizedGains: [] },
        { symbol: 'ETHUSDT', transactions: [ethBuy], realizedGains: [] },
      ]);

      const lines = csv.split('\n');
      expect(lines).toHaveLength(3);
      // BTC buy (Jan 15) before ETH buy (Feb 1)
      expect(lines[1]).toContain('BTC');
      expect(lines[2]).toContain('ETH');
    });

    it('filters by year', () => {
      const csv = generateTaxCsv(
        [
          {
            symbol: 'BTCUSDT',
            transactions: [buyTx, buyTx2],
            realizedGains: [longTermGain],
          },
        ],
        2025
      );

      const lines = csv.split('\n');
      // Only the 2025 sell from longTermGain
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('2025-06-15');
      expect(lines[1]).toContain('Long-term');
    });

    it('strips USDT from symbol in asset column', () => {
      const csv = generateTaxCsv([
        { symbol: 'BTCUSDT', transactions: [buyTx], realizedGains: [] },
      ]);

      const lines = csv.split('\n');
      expect(lines[1]).toContain('BTC');
      expect(lines[1]).not.toContain('BTCUSDT');
    });

    it('formats quantities correctly for small amounts', () => {
      const smallTx: Transaction = {
        type: 'buy',
        quantity: 0.00012345,
        price: 100000,
        date: new Date('2024-01-01'),
      };

      const csv = generateTaxCsv([
        { symbol: 'BTCUSDT', transactions: [smallTx], realizedGains: [] },
      ]);

      const lines = csv.split('\n');
      expect(lines[1]).toContain('0.00012345');
    });

    it('formats quantities correctly for large amounts', () => {
      const largeTx: Transaction = {
        type: 'buy',
        quantity: 5.5,
        price: 2200,
        date: new Date('2024-01-01'),
      };

      const csv = generateTaxCsv([
        { symbol: 'ETHUSDT', transactions: [largeTx], realizedGains: [] },
      ]);

      const lines = csv.split('\n');
      expect(lines[1]).toContain('5.5000');
    });

    it('leaves sell-specific fields empty for buy rows', () => {
      const csv = generateTaxCsv([
        { symbol: 'BTCUSDT', transactions: [buyTx], realizedGains: [] },
      ]);

      const lines = csv.split('\n');
      // Buy row should end with empty fields for proceeds, cost basis, gain, holding period
      const fields = lines[1].split(',');
      expect(fields[6]).toBe(''); // Proceeds
      expect(fields[7]).toBe(''); // Cost Basis
      expect(fields[8]).toBe(''); // Gain/Loss
      expect(fields[9]).toBe(''); // Holding Period
    });
  });
});
