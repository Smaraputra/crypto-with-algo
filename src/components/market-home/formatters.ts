export function getBaseAsset(symbol: string): string {
  const base = symbol.replace(/(USDT|USDC|BUSD|BTC|ETH)$/, '');
  return base || symbol;
}

export function getQuoteAsset(symbol: string): string {
  const match = symbol.match(/(USDT|USDC|BUSD|BTC|ETH)$/);
  return match ? match[1] : 'USDT';
}

export function formatCoinPrice(priceStr?: string | number): string {
  if (priceStr === undefined || priceStr === null || priceStr === '') return '';
  const num = typeof priceStr === 'string' ? parseFloat(priceStr) : priceStr;
  if (!Number.isFinite(num)) return '';

  if (num >= 1) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(num);
}

export function formatSignedPercent(changeStr?: string | number): {
  formatted: string;
  direction: 'up' | 'down' | 'flat';
} {
  if (changeStr === undefined || changeStr === null || changeStr === '') {
    return { formatted: '+0.00%', direction: 'flat' };
  }
  const num = typeof changeStr === 'string' ? parseFloat(changeStr) : changeStr;
  if (!Number.isFinite(num)) {
    return { formatted: '+0.00%', direction: 'flat' };
  }
  const absFormatted = Math.abs(num).toFixed(2);
  if (num > 0) {
    return { formatted: `+${absFormatted}%`, direction: 'up' };
  }
  if (num < 0) {
    return { formatted: `-${absFormatted}%`, direction: 'down' };
  }
  return { formatted: '+0.00%', direction: 'flat' };
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const ms = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
