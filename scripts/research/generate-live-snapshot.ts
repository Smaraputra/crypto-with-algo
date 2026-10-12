/**
 * Standalone verification utility: computes live 8-hour cross-sectional signals
 * directly from Binance without database side effects.
 *
 * Usage:
 *   npx tsx scripts/research/generate-live-snapshot.ts
 */

import { SIGNAL_SYMBOLS } from '../../src/lib/signals/signal-symbols';
import { fetchKlines } from '../../src/lib/binance';
import { fetchFundingRate } from '../../src/lib/binance-futures';
import {
  computeCrossSectionalSignalFromCandles,
  BAR_MS_8H,
} from '../../src/lib/signals/cross-sectional/generator';
import type { OHLCV } from '../../src/types/market';

async function main() {
  console.log('Fetching live 8h klines and funding rates for top 10 perpetual markets...');

  const candlesBySymbol = new Map<string, OHLCV[]>();
  const fundingRates = new Map<string, number>();

  await Promise.all(
    SIGNAL_SYMBOLS.map(async (sym) => {
      try {
        const raw = await fetchKlines(sym, '8h', 45);
        const now = Date.now();
        const closed = raw.filter((c) => c.timestamp + BAR_MS_8H <= now);
        candlesBySymbol.set(sym, closed);
      } catch (err) {
        console.error(`Failed to fetch 8h klines for ${sym}:`, err);
      }

      try {
        const rates = await fetchFundingRate(sym, 1);
        if (rates.length > 0) {
          fundingRates.set(sym, rates[0].fundingRate);
        }
      } catch (err) {
        console.error(`Failed to fetch funding rate for ${sym}:`, err);
      }
    })
  );

  console.log(`Fetched ${candlesBySymbol.size} candle series and ${fundingRates.size} funding rates.`);

  const result = computeCrossSectionalSignalFromCandles(candlesBySymbol, fundingRates);

  console.log('\n--- 8-Hour Cross-Sectional Relative Value Snapshot ---');
  console.log(`Bar Open:  ${new Date(result.timestamp).toISOString()}`);
  console.log(`Bar Close: ${new Date(result.barCloseTime).toISOString()}`);
  console.log(`Net Beta Exposure: ${result.netBetaExposure.toFixed(4)}`);
  console.log(`Gross Exposure:    ${result.grossExposure.toFixed(2)}`);
  console.log('\n--- Factor Rankings ---');
  console.table(
    result.ranks.map((r) => ({
      Rank: r.rank,
      Symbol: r.symbol,
      'Composite Z': r.compositeZ.toFixed(3),
      'Mom Z': r.zMom.toFixed(3),
      'Idio Z': r.zIdio.toFixed(3),
      'Carry Z': r.zCarry.toFixed(3),
      'Flow Z': r.zFlow.toFixed(3),
    }))
  );

  console.log('\n--- Target Allocations ---');
  console.table(
    result.targets
      .filter((t) => t.side !== 'flat')
      .map((t) => ({
        Symbol: t.symbol,
        Side: t.side.toUpperCase(),
        Weight: (t.weight * 100).toFixed(2) + '%',
      }))
  );
}

main().catch((err) => {
  console.error('Snapshot generation failed:', err);
  process.exit(1);
});
