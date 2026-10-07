/**
 * Symbol shapes. Symbols reach archive URLs and cache paths, so they are checked by shape.
 */

/**
 * A symbol as Binance names it: upper-case letters and digits, ending in a
 * quote asset. Strict on purpose.
 *
 * The symbol reaches the archive URL and, if a cache directory is ever wired
 * into the live route, the cache path. It is the one request parameter that is not
 * drawn from a fixed set, so it is the one that has to be checked by shape
 * rather than by membership. A value like `../../etc/passwd` is not a symbol
 * under this pattern and is refused before any path is built.
 */
export const SYMBOL_SHAPE = /^[A-Z0-9]{2,20}(USDT|USDC|BUSD|BTC|ETH)$/;

/**
 * The archive-contract shape used by research folders: a USDT-quoted ticker,
 * optionally with trailing SETTLED repeats (an earlier contract of a relisted
 * ticker). Longer tickers than the live shape are allowed (1000000MOGUSDT,
 * AERGOUSDTSETTLEDSETTLED).
 */
export const ARCHIVE_CONTRACT_SHAPE = /^[A-Z0-9]{1,40}USDT(SETTLED)*$/;
