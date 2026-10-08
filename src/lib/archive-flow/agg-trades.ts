import { looksLikeHeader } from '@/lib/external/binance-archive';

/** One row of a Binance UM aggTrades archive CSV. */
export interface AggTrade {
  price: number;
  quantity: number;
  firstTradeId: number;
  lastTradeId: number;
  /** Epoch ms. */
  transactTime: number;
  /** True: the buyer was the maker, so the taker sold. */
  isBuyerMaker: boolean;
}

/**
 * Columns: agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker.
 * Null for a header row (older files have none); throws on a malformed row.
 */
export function parseAggTradeLine(line: string): AggTrade | null {
  if (looksLikeHeader(line)) return null;

  const fields = line.split(',');
  if (fields.length !== 7) throw new Error(`Malformed aggTrades row (expected 7 fields): ${line}`);

  const price = Number(fields[1]);
  const quantity = Number(fields[2]);
  const firstTradeId = Number(fields[3]);
  const lastTradeId = Number(fields[4]);
  const transactTime = Number(fields[5]);
  const flag = fields[6].trim().toLowerCase();

  const valid =
    Number.isFinite(price) &&
    price >= 0 &&
    Number.isFinite(quantity) &&
    quantity >= 0 &&
    Number.isInteger(firstTradeId) &&
    Number.isInteger(lastTradeId) &&
    lastTradeId >= firstTradeId &&
    Number.isInteger(transactTime) &&
    transactTime > 0 &&
    (flag === 'true' || flag === 'false') &&
    fields[1].trim() !== '' &&
    fields[2].trim() !== '';
  if (!valid) throw new Error(`Malformed aggTrades row: ${line}`);

  return { price, quantity, firstTradeId, lastTradeId, transactTime, isBuyerMaker: flag === 'true' };
}
