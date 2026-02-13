import type { OHLCV } from '@/types/market';

const DB_NAME = 'cryptowithalgo-candles';
const DB_VERSION = 1;
const STORE_NAME = 'candles';
const MAX_ENTRIES = 50;

interface CacheEntry {
  key: string; // `${symbol}:${interval}`
  symbol: string;
  interval: string;
  candles: OHLCV[];
  startTime: number;
  endTime: number;
  fetchedAt: number;
}

function getTTL(interval: string): number {
  // Intraday intervals: 1 hour TTL
  // Daily+: 6 hours TTL
  const dailyPlus = ['1d', '1w', '1M'];
  return dailyPlus.includes(interval) ? 6 * 60 * 60 * 1000 : 60 * 60 * 1000;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getCachedCandles(
  symbol: string,
  interval: string
): Promise<OHLCV[] | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const key = `${symbol}:${interval}`;

    return new Promise((resolve) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const entry = request.result as CacheEntry | undefined;
        if (!entry) {
          resolve(null);
          return;
        }

        const ttl = getTTL(interval);
        if (Date.now() - entry.fetchedAt > ttl) {
          resolve(null);
          return;
        }

        resolve(entry.candles);
      };
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setCachedCandles(
  symbol: string,
  interval: string,
  candles: OHLCV[]
): Promise<void> {
  try {
    const db = await openDB();

    // Evict oldest entries if at capacity
    await evictIfNeeded(db);

    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const key = `${symbol}:${interval}`;

    const entry: CacheEntry = {
      key,
      symbol,
      interval,
      candles,
      startTime: candles[0]?.timestamp ?? 0,
      endTime: candles[candles.length - 1]?.timestamp ?? 0,
      fetchedAt: Date.now(),
    };

    store.put(entry);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently fail -- cache is optional
  }
}

export async function clearCandleCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Silently fail
  }
}

async function evictIfNeeded(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  const entries = await new Promise<CacheEntry[]>((resolve) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve([]);
  });

  if (entries.length < MAX_ENTRIES) return;

  // LRU eviction: sort by fetchedAt ascending, remove oldest
  entries.sort((a, b) => a.fetchedAt - b.fetchedAt);
  const toRemove = entries.length - MAX_ENTRIES + 1;

  const deleteTx = db.transaction(STORE_NAME, 'readwrite');
  const deleteStore = deleteTx.objectStore(STORE_NAME);
  for (let i = 0; i < toRemove; i++) {
    deleteStore.delete(entries[i].key);
  }

  await new Promise<void>((resolve) => {
    deleteTx.oncomplete = () => resolve();
    deleteTx.onerror = () => resolve();
  });
}
