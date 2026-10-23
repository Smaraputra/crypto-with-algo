import type { Page } from '@playwright/test';
import type { Symbol } from '@/types/market';

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

declare global {
  interface Window {
    __esUrls?: string[];
    __esFrames?: unknown[];
    __esLast?: unknown;
    __esPush?: (frame: unknown) => void;
    __esFail?: (opts?: { closed?: boolean }) => void;
    __esUpstreamClosed?: () => void;
  }
}

// Route fulfil ends the SSE body at once; this fake keeps the connection open deterministically.
/**
 * Replaces window.EventSource before any page script runs with a fake that stays open.
 * Each instance: records its url in window.__esUrls, fires `open` 50 ms after creation, then delivers
 * every frame in window.__esFrames (set by the test, default []) as `message` events with JSON data.
 * window.__esLast is the newest instance. Control from tests with page.evaluate:
 *   window.__esPush(frame)        -> a `message` on the newest instance
 *   window.__esFail({ closed })   -> readyState CLOSED (2) or CONNECTING (0), then an `error` event
 *   window.__esUpstreamClosed()   -> the named `upstream-closed` event
 * close() sets readyState 2 and stops deliveries.
 */
export async function installFakeEventSource(
  page: Page,
  frames: unknown[] = []
): Promise<void> {
  await page.addInitScript(
    (initialFrames: unknown[]) => {
      window.__esUrls = window.__esUrls || [];
      window.__esFrames = Array.isArray(initialFrames) ? initialFrames : [];
      window.__esLast = null;

      class FakeEventSource extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;

        readonly CONNECTING = 0;
        readonly OPEN = 1;
        readonly CLOSED = 2;

        url: string;
        readyState: number = FakeEventSource.CONNECTING;
        withCredentials = false;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        _openTimer: ReturnType<typeof setTimeout> | null = null;

        constructor(url: string | URL) {
          super();
          this.url = String(url);
          this.readyState = FakeEventSource.CONNECTING;

          if (!window.__esUrls) {
            window.__esUrls = [];
          }
          window.__esUrls.push(this.url);
          window.__esLast = this;

          this._openTimer = setTimeout(() => {
            this._openTimer = null;
            if (this.readyState === FakeEventSource.CLOSED) {
              return;
            }
            this.readyState = FakeEventSource.OPEN;
            this._dispatch('open', new Event('open'));

            const queue = window.__esFrames || [];
            for (const frame of queue) {
              if (this.readyState === FakeEventSource.CLOSED) {
                break;
              }
              this._deliver(frame);
            }
          }, 50);
        }

        close(): void {
          this.readyState = FakeEventSource.CLOSED;
          if (this._openTimer !== null) {
            clearTimeout(this._openTimer);
            this._openTimer = null;
          }
        }

        _deliver(frame: unknown): void {
          if (this.readyState === FakeEventSource.CLOSED) {
            return;
          }
          const data = typeof frame === 'string' ? frame : JSON.stringify(frame);
          const event =
            typeof MessageEvent !== 'undefined'
              ? new MessageEvent('message', { data })
              : Object.assign(new Event('message'), { data });
          this._dispatch('message', event);
        }

        _dispatch(type: string, event: Event): void {
          const handler = (
            this as unknown as Record<string, ((ev: Event) => void) | null | undefined>
          )['on' + type];
          if (typeof handler === 'function') {
            try {
              handler.call(this, event);
            } catch (err) {
              console.error(err);
            }
          }
          this.dispatchEvent(event);
        }
      }

      window.EventSource = FakeEventSource as unknown as typeof EventSource;

      window.__esPush = (frame: unknown) => {
        const last = window.__esLast as FakeEventSource | null | undefined;
        if (last && typeof last._deliver === 'function') {
          last._deliver(frame);
        }
      };

      window.__esFail = (opts?: { closed?: boolean }) => {
        const last = window.__esLast as FakeEventSource | null | undefined;
        if (last) {
          const closed = Boolean(opts?.closed);
          last.readyState = closed ? FakeEventSource.CLOSED : FakeEventSource.CONNECTING;
          if (closed && last._openTimer !== null) {
            clearTimeout(last._openTimer);
            last._openTimer = null;
          }
          last._dispatch('error', new Event('error'));
        }
      };

      window.__esUpstreamClosed = () => {
        const last = window.__esLast as FakeEventSource | null | undefined;
        if (last && typeof last._dispatch === 'function') {
          last._dispatch('upstream-closed', new Event('upstream-closed'));
        }
      };
    },
    frames
  );
}

/** The URLs the page has opened through the fake (read via page.evaluate). */
export async function fakeEventSourceUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__esUrls ? [...window.__esUrls] : []));
}

export function closedKlineFrame(
  symbol: string,
  interval: string,
  closeTime: number,
  close: number | string
) {
  const closeStr = typeof close === 'number' ? close.toFixed(2) : close;
  const symbolUpper = symbol.toUpperCase();
  const symbolLower = symbol.toLowerCase();
  return {
    stream: `${symbolLower}@kline_${interval}`,
    data: {
      e: 'kline',
      s: symbolUpper,
      k: {
        t: closeTime - 59_999,
        T: closeTime,
        o: closeStr,
        h: closeStr,
        l: closeStr,
        c: closeStr,
        v: '100',
        V: '50',
        x: true,
      },
    },
  };
}

export async function mockLevels(
  page: Page,
  levels: Record<
    string,
    {
      high: number;
      low: number;
      close: number;
      atr: number;
      dayStart: number;
    } | null
  >,
  opts?: { fail?: boolean }
): Promise<void> {
  await page.route('**/api/market/levels**', async (route) => {
    if (opts?.fail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed' }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        asOf: new Date().toISOString(),
        levels,
      }),
    });
  });
}

export async function mockLab(
  page: Page,
  body: unknown,
  opts?: { fail?: boolean }
): Promise<void> {
  await page.route('**/api/signals/lab', async (route) => {
    if (opts?.fail) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed' }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

export const DEFAULT_MOCK_SYMBOLS: Symbol[] = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
  { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' },
  { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT' },
];

export async function mockSymbols(
  page: Page,
  symbols: Symbol[] = DEFAULT_MOCK_SYMBOLS
): Promise<void> {
  await page.route('**/api/symbols*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(symbols),
    });
  });
}

