const INTERVAL_MS: Record<string, number> = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

export function intervalToMs(interval: string): number {
  const ms = INTERVAL_MS[interval];
  if (ms === undefined) {
    throw new Error(`Unknown interval: ${interval}`);
  }
  return ms;
}
