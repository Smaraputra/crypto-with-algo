import { describe, it, expect } from 'vitest';
import {
  generateFallbackData,
  buildHoldings,
  buildAlerts,
  buildSnapshots,
  type DailyPrices,
} from './seed';

describe('Seed data generation', () => {
  describe('generateFallbackData', () => {
    it('returns current prices for all holding symbols', () => {
      const { currentPrices } = generateFallbackData();
      expect(currentPrices).toHaveProperty('BTCUSDT');
      expect(currentPrices).toHaveProperty('ETHUSDT');
      expect(currentPrices).toHaveProperty('SOLUSDT');
      expect(currentPrices).toHaveProperty('BNBUSDT');
      expect(currentPrices).toHaveProperty('XRPUSDT');
      expect(currentPrices['BTCUSDT']).toBeGreaterThan(0);
    });

    it('returns 30 daily price entries per symbol', () => {
      const { dailyPrices } = generateFallbackData();
      expect(dailyPrices['BTCUSDT']).toHaveLength(30);
      expect(dailyPrices['ETHUSDT']).toHaveLength(30);
    });

    it('daily prices have date and close fields', () => {
      const { dailyPrices } = generateFallbackData();
      const entry = dailyPrices['BTCUSDT'][0];
      expect(entry).toHaveProperty('date');
      expect(entry).toHaveProperty('close');
      expect(entry.date).toBeInstanceOf(Date);
      expect(entry.close).toBeGreaterThan(0);
    });
  });

  describe('buildHoldings', () => {
    it('creates holdings with correct structure', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices);

      expect(holdings).toHaveLength(5);
      expect(holdings[0]).toMatchObject({
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
      });
    });

    it('each holding has 3 buy transactions', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices);

      for (const h of holdings) {
        expect(h.transactions).toHaveLength(3);
        for (const tx of h.transactions) {
          expect(tx.type).toBe('buy');
          expect(tx.quantity).toBeGreaterThan(0);
          expect(tx.price).toBeGreaterThan(0);
          expect(tx.date).toBeInstanceOf(Date);
        }
      }
    });

    it('avgBuyPrice is weighted average of transactions', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices);

      for (const h of holdings) {
        const totalQty = h.transactions.reduce((s, t) => s + t.quantity, 0);
        const totalCost = h.transactions.reduce(
          (s, t) => s + t.quantity * t.price,
          0
        );
        const expected = totalCost / totalQty;
        expect(h.avgBuyPrice).toBeCloseTo(expected, 4);
      }
    });

    it('transaction quantities sum to holding quantity', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices);

      for (const h of holdings) {
        const txSum = h.transactions.reduce((s, t) => s + t.quantity, 0);
        expect(h.quantity).toBeCloseTo(txSum, 6);
      }
    });
  });

  describe('buildAlerts', () => {
    it('creates 4 alerts', () => {
      const prices = { BTCUSDT: 67000, ETHUSDT: 3500, SOLUSDT: 140 };
      const alerts = buildAlerts(prices, 'portfolio-123');
      expect(alerts).toHaveLength(4);
    });

    it('first alert is BTC price_above at 5% above current', () => {
      const prices = { BTCUSDT: 67000, ETHUSDT: 3500, SOLUSDT: 140 };
      const alerts = buildAlerts(prices, 'portfolio-123');
      const btcAlert = alerts[0];
      expect(btcAlert.symbol).toBe('BTCUSDT');
      expect(btcAlert.type).toBe('price_above');
      expect(btcAlert.status).toBe('active');
      expect(btcAlert.targetPrice).toBeCloseTo(67000 * 1.05, 0);
    });

    it('third alert is triggered with triggeredAt set', () => {
      const prices = { BTCUSDT: 67000, ETHUSDT: 3500, SOLUSDT: 140 };
      const alerts = buildAlerts(prices, 'portfolio-123');
      expect(alerts[2].status).toBe('triggered');
      expect(alerts[2].triggeredAt).toBeInstanceOf(Date);
    });

    it('fourth alert is a portfolio value alert', () => {
      const prices = { BTCUSDT: 67000, ETHUSDT: 3500, SOLUSDT: 140 };
      const alerts = buildAlerts(prices, 'portfolio-123');
      expect(alerts[3].type).toBe('portfolio_value_above');
      expect(alerts[3].portfolioId).toBe('portfolio-123');
      expect(alerts[3].recurring).toBe(true);
    });
  });

  describe('buildSnapshots', () => {
    it('creates snapshots matching the number of daily price entries', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices).map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        avgBuyPrice: h.avgBuyPrice,
      }));

      const snapshots = buildSnapshots(holdings, dailyPrices, 'port-1');
      expect(snapshots.length).toBe(30);
    });

    it('each snapshot has correct structure', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices).map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        avgBuyPrice: h.avgBuyPrice,
      }));

      const snapshots = buildSnapshots(holdings, dailyPrices, 'port-1');
      const snap = snapshots[0];

      expect(snap).toHaveProperty('portfolioId', 'port-1');
      expect(snap).toHaveProperty('date');
      expect(snap).toHaveProperty('totalValue');
      expect(snap).toHaveProperty('totalCost');
      expect(snap).toHaveProperty('unrealizedPnl');
      expect(snap).toHaveProperty('unrealizedPnlPercent');
      expect(snap).toHaveProperty('holdings');
      expect(snap.holdings).toHaveLength(5);
    });

    it('snapshot totalValue equals sum of holding values', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices).map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        avgBuyPrice: h.avgBuyPrice,
      }));

      const snapshots = buildSnapshots(holdings, dailyPrices, 'port-1');

      for (const snap of snapshots) {
        const sumValues = snap.holdings.reduce((s, h) => s + h.value, 0);
        expect(snap.totalValue).toBeCloseTo(sumValues, 1);
      }
    });

    it('unrealizedPnl is totalValue minus totalCost', () => {
      const { dailyPrices } = generateFallbackData();
      const holdings = buildHoldings(dailyPrices).map((h) => ({
        symbol: h.symbol,
        quantity: h.quantity,
        avgBuyPrice: h.avgBuyPrice,
      }));

      const snapshots = buildSnapshots(holdings, dailyPrices, 'port-1');

      for (const snap of snapshots) {
        expect(snap.unrealizedPnl).toBeCloseTo(
          snap.totalValue - snap.totalCost,
          1
        );
      }
    });

    it('handles empty daily prices gracefully', () => {
      const dailyPrices: DailyPrices = {};
      const holdings = [
        { symbol: 'BTCUSDT', quantity: 1, avgBuyPrice: 60000 },
      ];
      const snapshots = buildSnapshots(holdings, dailyPrices, 'port-1');
      expect(snapshots).toHaveLength(0);
    });
  });
});
