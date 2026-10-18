import type { Page } from '@playwright/test';

export interface MockHistoryOptions {
  fail?: boolean;
}

export function tickerFrame(symbol: string, price: number | string) {
  const priceStr = typeof price === 'number' ? price.toFixed(2) : price;
  const symbolUpper = symbol.toUpperCase();
  const symbolLower = symbol.toLowerCase();
  return {
    stream: `${symbolLower}@ticker`,
    data: {
      e: '24hrTicker',
      s: symbolUpper,
      c: priceStr,
      p: '0.00',
      P: '0.00',
      o: priceStr,
      h: priceStr,
      l: priceStr,
      v: '1000',
      q: '1000000',
      n: 100,
    },
  };
}

export function klineFrame(symbol: string, interval: string, close: number | string) {
  const closeStr = typeof close === 'number' ? close.toFixed(2) : close;
  const symbolUpper = symbol.toUpperCase();
  const symbolLower = symbol.toLowerCase();
  return {
    stream: `${symbolLower}@kline_${interval}`,
    data: {
      e: 'kline',
      s: symbolUpper,
      k: {
        t: Date.now(),
        o: closeStr,
        h: closeStr,
        l: closeStr,
        c: closeStr,
        v: '100',
        V: '50',
        x: false,
      },
    },
  };
}

export async function mockHistory(page: Page, opts?: MockHistoryOptions): Promise<void> {
  await page.route('**/api/prices/history**', async (route) => {
    if (opts?.fail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to fetch price history' }),
      });
      return;
    }

    const now = Date.now();
    const currentHour = now - (now % (3600 * 1000));
    const bars = Array.from({ length: 60 }, (_, i) => {
      const timestamp = currentHour - (59 - i) * 3600 * 1000;
      const base = 50000 + i * 10;
      return {
        timestamp,
        open: base,
        high: base + 50,
        low: base - 50,
        close: base + 20,
        volume: 100 + i,
      };
    });

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(bars),
    });
  });
}

export async function mockStream(
  page: Page,
  frames: Array<unknown> | ((url: string) => Array<unknown>) = [
    tickerFrame('BTCUSDT', 50000),
    klineFrame('BTCUSDT', '1h', 50000),
  ]
): Promise<string[]> {
  const requestedUrls: string[] = [];

  await page.route('**/api/stream?**', async (route) => {
    const url = route.request().url();
    requestedUrls.push(url);

    const resolved = typeof frames === 'function' ? frames(url) : frames;
    let body = 'retry: 1000\n\n';
    for (const frame of resolved) {
      body += `data: ${JSON.stringify(frame)}\n\n`;
    }

    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
      body,
    });
  });

  return requestedUrls;
}
