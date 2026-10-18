export type StreamStatus = 'connecting' | 'live' | 'stale' | 'reconnecting' | 'offline';

export interface StreamSnapshot {
  status: StreamStatus;
  /** Epoch ms of the last data frame, throttled to at most one snapshot change per second. Null before the first frame. */
  lastMessageAt: number | null;
}

export interface CombinedFrame {
  stream: string;
  data: unknown;
}

export interface MarketStreamClient {
  /** Adds the streams to the shared set (ref-counted) and calls onFrame for frames whose `stream` is in `streams`. Returns an unsubscribe. */
  subscribe(streams: readonly string[], onFrame: (frame: CombinedFrame) => void): () => void;
  getSnapshot(): StreamSnapshot;
  /** Listener for snapshot changes (for React's useSyncExternalStore). Returns an unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Closes the current connection, resets backoff and reconnects at once. */
  retry(): void;
  /** Closes everything and removes all listeners (tests and teardown). */
  dispose(): void;
}

export interface MarketStreamClientOptions {
  url?: string; // default '/api/stream'
  staleAfterMs?: number; // default 15_000
  resubscribeDebounceMs?: number; // default 250
  baseBackoffMs?: number; // default 1_000
  maxBackoffMs?: number; // default 30_000
  now?: () => number; // default Date.now
  random?: () => number; // default Math.random (jitter)
  EventSourceImpl?: typeof EventSource; // default globalThis.EventSource
  win?: Pick<Window, 'addEventListener' | 'removeEventListener'>; // default window
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>; // default document
  nav?: Pick<Navigator, 'onLine'>; // default navigator
}

interface SubscriberRecord {
  streams: Set<string>;
  onFrame: (frame: CombinedFrame) => void;
}

export function createMarketStreamClient(
  options?: MarketStreamClientOptions
): MarketStreamClient {
  const url = options?.url ?? '/api/stream';
  const staleAfterMs = options?.staleAfterMs ?? 15_000;
  const resubscribeDebounceMs = options?.resubscribeDebounceMs ?? 250;
  const baseBackoffMs = options?.baseBackoffMs ?? 1_000;
  const maxBackoffMs = options?.maxBackoffMs ?? 30_000;
  const now = options?.now ?? Date.now;
  const random = options?.random ?? Math.random;
  const EventSourceImpl =
    options?.EventSourceImpl ??
    (typeof EventSource !== 'undefined'
      ? EventSource
      : (typeof globalThis !== 'undefined'
          ? (globalThis as unknown as { EventSource: typeof EventSource }).EventSource
          : undefined));
  const win = options?.win ?? (typeof window !== 'undefined' ? window : undefined);
  const doc = options?.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const nav = options?.nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);

  let currentSnapshot: StreamSnapshot = {
    status: 'connecting',
    lastMessageAt: null,
  };

  const onChangeListeners = new Set<() => void>();
  const subscribers = new Set<SubscriberRecord>();
  const streamRefCount = new Map<string, number>();

  let currentSource: EventSource | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let staleInterval: ReturnType<typeof setInterval> | null = null;

  let hadBeenLive = false;
  let attempt = 0;
  let lastFrameTime: number | null = null;
  let windowListenersAttached = false;

  function setSnapshot(status: StreamStatus, lastMessageAt: number | null): void {
    if (status === currentSnapshot.status && lastMessageAt === currentSnapshot.lastMessageAt) {
      return;
    }
    currentSnapshot = { status, lastMessageAt };
    for (const listener of onChangeListeners) {
      try {
        listener();
      } catch {
        // ignore subscriber listener errors
      }
    }
  }

  function clearDebounceTimer(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function clearBackoffTimer(): void {
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  }

  function scheduleDebounce(): void {
    clearDebounceTimer();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      resubscribe();
    }, resubscribeDebounceMs);
  }

  function checkStale(): void {
    if (currentSnapshot.status === 'live' && lastFrameTime !== null) {
      if (now() - lastFrameTime > staleAfterMs) {
        setSnapshot('stale', currentSnapshot.lastMessageAt);
      }
    }
  }

  function startStaleInterval(): void {
    if (staleInterval === null) {
      staleInterval = setInterval(checkStale, 1_000);
    }
  }

  function stopStaleInterval(): void {
    if (staleInterval !== null) {
      clearInterval(staleInterval);
      staleInterval = null;
    }
  }

  function closeSource(): void {
    if (currentSource) {
      currentSource.onopen = null;
      currentSource.onmessage = null;
      currentSource.onerror = null;
      currentSource.removeEventListener('upstream-closed', handleUpstreamClosed);
      currentSource.close();
      currentSource = null;
    }
  }

  const handleMessage = (event: MessageEvent): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>).stream !== 'string'
    ) {
      return;
    }

    const stream = (parsed as Record<string, unknown>).stream as string;
    const data = (parsed as Record<string, unknown>).data;
    const frameTime = now();
    lastFrameTime = frameTime;

    const frame: CombinedFrame = { stream, data };
    for (const sub of subscribers) {
      if (sub.streams.has(stream)) {
        try {
          sub.onFrame(frame);
        } catch {
          // ignore subscriber error
        }
      }
    }

    let nextLastMessageAt = currentSnapshot.lastMessageAt;
    if (
      currentSnapshot.lastMessageAt === null ||
      frameTime - currentSnapshot.lastMessageAt >= 1_000
    ) {
      nextLastMessageAt = frameTime;
    }

    setSnapshot('live', nextLastMessageAt);
  };

  const handleUpstreamClosed = (): void => {
    setSnapshot('reconnecting', currentSnapshot.lastMessageAt);
  };

  const handleError = (): void => {
    if (nav && nav.onLine === false) {
      setSnapshot('offline', currentSnapshot.lastMessageAt);
      return;
    }

    if (currentSource && currentSource.readyState === 2 /* CLOSED */) {
      closeSource();
      setSnapshot('reconnecting', currentSnapshot.lastMessageAt);
      const backoff =
        Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, attempt)) * (0.5 + random() / 2);
      attempt += 1;
      clearBackoffTimer();
      backoffTimer = setTimeout(() => {
        backoffTimer = null;
        resubscribe();
      }, backoff);
      return;
    }

    setSnapshot('reconnecting', currentSnapshot.lastMessageAt);
  };

  const handleOnline = (): void => {
    retry();
  };

  const handleOffline = (): void => {
    clearBackoffTimer();
    setSnapshot('offline', currentSnapshot.lastMessageAt);
  };

  const handleVisibilityChange = (): void => {
    if (
      doc &&
      doc.visibilityState === 'visible' &&
      (currentSnapshot.status === 'stale' ||
        currentSnapshot.status === 'reconnecting' ||
        currentSnapshot.status === 'offline')
    ) {
      retry();
    }
  };

  function attachWindowListeners(): void {
    if (windowListenersAttached) return;
    windowListenersAttached = true;
    win?.addEventListener('online', handleOnline);
    win?.addEventListener('offline', handleOffline);
    doc?.addEventListener('visibilitychange', handleVisibilityChange);
  }

  function detachWindowListeners(): void {
    if (!windowListenersAttached) return;
    windowListenersAttached = false;
    win?.removeEventListener('online', handleOnline);
    win?.removeEventListener('offline', handleOffline);
    doc?.removeEventListener('visibilitychange', handleVisibilityChange);
  }

  function resubscribe(): void {
    clearBackoffTimer();
    clearDebounceTimer();
    closeSource();

    if (streamRefCount.size === 0) {
      setSnapshot('connecting', currentSnapshot.lastMessageAt);
      return;
    }

    const names = Array.from(streamRefCount.keys()).sort();
    const fullUrl = `${url}?streams=${names.join('/')}`;

    setSnapshot(hadBeenLive ? 'reconnecting' : 'connecting', currentSnapshot.lastMessageAt);

    if (!EventSourceImpl) {
      return;
    }

    const source = new EventSourceImpl(fullUrl);
    currentSource = source;

    source.onopen = () => {
      hadBeenLive = true;
      attempt = 0;
      lastFrameTime = now();
      setSnapshot('live', currentSnapshot.lastMessageAt);
    };

    source.onmessage = handleMessage;
    source.onerror = handleError;
    source.addEventListener('upstream-closed', handleUpstreamClosed);
  }

  function retry(): void {
    clearBackoffTimer();
    clearDebounceTimer();
    attempt = 0;
    resubscribe();
  }

  function dispose(): void {
    clearDebounceTimer();
    clearBackoffTimer();
    stopStaleInterval();
    detachWindowListeners();
    closeSource();
    subscribers.clear();
    streamRefCount.clear();
    onChangeListeners.clear();
  }

  function subscribe(
    streams: readonly string[],
    onFrame: (frame: CombinedFrame) => void
  ): () => void {
    attachWindowListeners();

    const uniqueStreams = Array.from(new Set(streams));
    const subRecord: SubscriberRecord = {
      streams: new Set(uniqueStreams),
      onFrame,
    };
    subscribers.add(subRecord);

    let changed = false;
    for (const name of uniqueStreams) {
      const prev = streamRefCount.get(name);
      if (prev === undefined) {
        streamRefCount.set(name, 1);
        changed = true;
      } else {
        streamRefCount.set(name, prev + 1);
      }
    }

    if (streamRefCount.size > 0) {
      startStaleInterval();
    }

    if (changed) {
      scheduleDebounce();
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      subscribers.delete(subRecord);

      let countChanged = false;
      for (const name of uniqueStreams) {
        const count = streamRefCount.get(name);
        if (count !== undefined) {
          if (count <= 1) {
            streamRefCount.delete(name);
            countChanged = true;
          } else {
            streamRefCount.set(name, count - 1);
          }
        }
      }

      if (streamRefCount.size === 0) {
        stopStaleInterval();
      }

      if (countChanged) {
        scheduleDebounce();
      }
    };
  }

  return {
    subscribe,
    getSnapshot(): StreamSnapshot {
      return currentSnapshot;
    },
    onChange(listener: () => void): () => void {
      onChangeListeners.add(listener);
      return () => {
        onChangeListeners.delete(listener);
      };
    },
    retry,
    dispose,
  };
}

let defaultClient: MarketStreamClient | null = null;

/** Lazy browser singleton built with the defaults. */
export function getMarketStreamClient(): MarketStreamClient {
  if (!defaultClient) {
    defaultClient = createMarketStreamClient();
  }
  return defaultClient;
}
