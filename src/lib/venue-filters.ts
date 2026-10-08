/**
 * Pure parsing of Binance USDT-M `exchangeInfo` symbol filters. No server-only
 * imports, so both the demo client and the cost-check route (and any client
 * bundle) can use it.
 */

/** The slice of an exchangeInfo symbol this parser reads. */
export interface ExchangeInfoSymbolFilters {
  symbol: string;
  status: string;
  contractType: string;
  filters: Array<Record<string, string>>;
}

export interface ParsedVenueFilter {
  symbol: string;
  status: string;
  /** LOT_SIZE step, in base units. */
  stepSize: number;
  /** LOT_SIZE minimum quantity, in base units. */
  minQty: number;
  /** MIN_NOTIONAL, in quote units. */
  minNotional: number;
  /** PRICE_FILTER tick. */
  tickSize: number;
  /** MARKET_LOT_SIZE step, when the symbol has one (market orders use it). */
  marketStepSize?: number;
  /** MARKET_LOT_SIZE minimum quantity, when present. */
  marketMinQty?: number;
}

/**
 * Perpetual symbols with the three required filters (LOT_SIZE, MIN_NOTIONAL,
 * PRICE_FILTER). Symbols missing any of them, and non-perpetual contracts,
 * are skipped.
 */
export function parseVenueFilters(
  symbols: readonly ExchangeInfoSymbolFilters[]
): Map<string, ParsedVenueFilter> {
  const out = new Map<string, ParsedVenueFilter>();
  for (const s of symbols) {
    if (s.contractType !== 'PERPETUAL') continue;
    const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
    const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
    const price = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
    if (!lot || !notional || !price) continue;
    const market = s.filters.find((f) => f.filterType === 'MARKET_LOT_SIZE');
    const parsed: ParsedVenueFilter = {
      symbol: s.symbol,
      status: s.status,
      stepSize: Number(lot.stepSize),
      minQty: Number(lot.minQty),
      minNotional: Number(notional.notional),
      tickSize: Number(price.tickSize),
    };
    if (market) {
      parsed.marketStepSize = Number(market.stepSize);
      parsed.marketMinQty = Number(market.minQty);
    }
    out.set(s.symbol, parsed);
  }
  return out;
}
