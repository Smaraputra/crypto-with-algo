// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMarketStreamClient,
  getMarketStreamClient,
  type MarketStreamClient,
} from './client';
import { MockEventSource } from '@/test/mock-event-source';

interface FakeDoc extends EventTarget {
  visibilityState: DocumentVisibilityState;
}

interface FakeNav {
  onLine: boolean;
}

describe('MarketStreamClient', () => {
  let client: MarketStreamClient;
  let win: EventTarget;
  let doc: FakeDoc;
  let nav: FakeNav;

  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.resetMock();
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible' as DocumentVisibilityState,
    });
    nav = { onLine: true };

    client = createMarketStreamClient({
      EventSourceImpl: MockEventSource,
      random: () => 1,
      now: () => Date.now(),
      win,
      doc,
      nav,
    });
  });

  afterEach(() => {
    client.dispose();
    MockEventSource.resetMock();
    vi.useRealTimers();
  });

  it('opens exactly one source with sorted streams when multiple subscribers join within debounce window', () => {
    const onFrame1 = vi.fn();
    const onFrame2 = vi.fn();

    client.subscribe(['btcusdt@ticker'], onFrame1);
    vi.advanceTimersByTime(100);
    client.subscribe(['ethusdt@ticker'], onFrame2);

    expect(MockEventSource.instances).toHaveLength(0);
    vi.advanceTimersByTime(250);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.lastInstance?.url).toBe(
      '/api/stream?streams=btcusdt@ticker/ethusdt@ticker'
    );
  });

  it('reports status connecting before open and live after simulateOpen()', () => {
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);

    expect(client.getSnapshot().status).toBe('connecting');
    MockEventSource.lastInstance?.simulateOpen();
    expect(client.getSnapshot().status).toBe('live');
  });

  it('delivers frame only to matching subscriber and sets lastMessageAt', () => {
    const btcCallback = vi.fn();
    const ethCallback = vi.fn();

    client.subscribe(['btcusdt@ticker'], btcCallback);
    client.subscribe(['ethusdt@ticker'], ethCallback);
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();

    MockEventSource.lastInstance?.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { c: '1' },
    });

    expect(btcCallback).toHaveBeenCalledTimes(1);
    expect(btcCallback).toHaveBeenCalledWith({
      stream: 'btcusdt@ticker',
      data: { c: '1' },
    });
    expect(ethCallback).not.toHaveBeenCalled();
    expect(client.getSnapshot().lastMessageAt).toBe(Date.now());
  });

  it('ignores malformed frame without throwing or calling subscribers', () => {
    const callback = vi.fn();
    client.subscribe(['btcusdt@ticker'], callback);
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();

    expect(() => {
      MockEventSource.lastInstance?.simulateMessage('not json');
    }).not.toThrow();

    expect(callback).not.toHaveBeenCalled();
  });

  it('reopens with remaining stream after debounce on unsubscribe and closes on complete unsubscribe', () => {
    const unsubBtc = client.subscribe(['btcusdt@ticker'], vi.fn());
    const unsubEth = client.subscribe(['ethusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.lastInstance?.url).toBe(
      '/api/stream?streams=btcusdt@ticker/ethusdt@ticker'
    );

    unsubBtc();
    vi.advanceTimersByTime(250);

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[0].closed).toBe(true);
    expect(MockEventSource.lastInstance?.url).toBe('/api/stream?streams=ethusdt@ticker');

    unsubEth();
    vi.advanceTimersByTime(250);

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].closed).toBe(true);
    expect(client.getSnapshot().status).toBe('connecting');
  });

  it('does not drop another subscriber when unsubscribe is called twice', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const unsub1 = client.subscribe(['btcusdt@ticker'], cb1);
    client.subscribe(['btcusdt@ticker'], cb2);
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();

    unsub1();
    unsub1();
    vi.advanceTimersByTime(250);

    MockEventSource.lastInstance?.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { price: '100' },
    });
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('transitions to stale after 16s without frames and returns to live on new frame', () => {
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();
    expect(client.getSnapshot().status).toBe('live');

    vi.advanceTimersByTime(16_000);
    expect(client.getSnapshot().status).toBe('stale');

    MockEventSource.lastInstance?.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { price: '100' },
    });
    expect(client.getSnapshot().status).toBe('live');
  });

  it('sets status to reconnecting when simulateEvent upstream-closed fires', () => {
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();
    expect(client.getSnapshot().status).toBe('live');

    MockEventSource.lastInstance?.simulateEvent('upstream-closed');
    expect(client.getSnapshot().status).toBe('reconnecting');
  });

  it('backs off exponentially on closed error and resets backoff on retry()', () => {
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    const source1 = MockEventSource.lastInstance!;
    source1.simulateOpen();

    source1.simulateError({ closed: true });
    expect(source1.closed).toBe(true);
    expect(client.getSnapshot().status).toBe('reconnecting');
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(2);

    const source2 = MockEventSource.lastInstance!;
    source2.simulateError({ closed: true });
    expect(source2.closed).toBe(true);

    vi.advanceTimersByTime(1_999);
    expect(MockEventSource.instances).toHaveLength(2);

    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(3);

    client.retry();
    expect(MockEventSource.instances).toHaveLength(4);

    const source4 = MockEventSource.lastInstance!;
    source4.simulateError({ closed: true });
    expect(source4.closed).toBe(true);

    vi.advanceTimersByTime(999);
    expect(MockEventSource.instances).toHaveLength(4);

    vi.advanceTimersByTime(1);
    expect(MockEventSource.instances).toHaveLength(5);
  });

  it('sets status to reconnecting without opening new source when readyState is CONNECTING', () => {
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    const source = MockEventSource.lastInstance!;
    source.simulateOpen();

    source.simulateError();
    expect(client.getSnapshot().status).toBe('reconnecting');
    expect(MockEventSource.instances).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it('sets status to offline when nav.onLine is false and reopens on online event', () => {
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    const source = MockEventSource.lastInstance!;
    source.simulateOpen();

    nav.onLine = false;
    source.simulateError();
    expect(client.getSnapshot().status).toBe('offline');

    const beforeCount = MockEventSource.instances.length;
    win.dispatchEvent(new Event('online'));
    expect(MockEventSource.instances.length).toBe(beforeCount + 1);
  });

  it('reopens on visibilitychange when visible and stale but not when live', () => {
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();
    expect(client.getSnapshot().status).toBe('live');

    const countWhileLive = MockEventSource.instances.length;
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(MockEventSource.instances.length).toBe(countWhileLive);

    vi.advanceTimersByTime(16_000);
    expect(client.getSnapshot().status).toBe('stale');

    doc.dispatchEvent(new Event('visibilitychange'));
    expect(MockEventSource.instances.length).toBe(countWhileLive + 1);
  });

  it('returns stable snapshot reference between changes and fires onChange only on actual changes', () => {
    const onChangeListener = vi.fn();
    client.onChange(onChangeListener);

    const snap1 = client.getSnapshot();
    const snap2 = client.getSnapshot();
    expect(snap1).toBe(snap2);
    expect(onChangeListener).not.toHaveBeenCalled();

    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();

    const snap3 = client.getSnapshot();
    expect(snap3).not.toBe(snap1);
    expect(snap3.status).toBe('live');
    expect(onChangeListener).toHaveBeenCalled();

    const changeCount = onChangeListener.mock.calls.length;
    const snap4 = client.getSnapshot();
    expect(snap4).toBe(snap3);
    expect(onChangeListener).toHaveBeenCalledTimes(changeCount);
  });

  it('throttles lastMessageAt changes to at most once per 1000ms under a burst of frames', () => {
    const onChangeListener = vi.fn();
    client.subscribe(['btcusdt@ticker'], vi.fn());
    vi.advanceTimersByTime(250);
    MockEventSource.lastInstance?.simulateOpen();
    client.onChange(onChangeListener);

    MockEventSource.lastInstance?.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { seq: 1 },
    });
    const t1 = client.getSnapshot().lastMessageAt;
    expect(t1).not.toBeNull();
    expect(onChangeListener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(200);
    MockEventSource.lastInstance?.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { seq: 2 },
    });
    expect(client.getSnapshot().lastMessageAt).toBe(t1);
    expect(onChangeListener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    MockEventSource.lastInstance?.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { seq: 3 },
    });
    expect(client.getSnapshot().lastMessageAt).toBe(t1);
    expect(onChangeListener).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(301);
    MockEventSource.lastInstance?.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { seq: 4 },
    });
    const t2 = client.getSnapshot().lastMessageAt;
    expect(t2).not.toBe(t1);
    expect(t2).toBe(Date.now());
    expect(onChangeListener).toHaveBeenCalledTimes(2);
  });

  it('closes the source and stops subscriber callbacks after dispose', () => {
    const callback = vi.fn();
    client.subscribe(['btcusdt@ticker'], callback);
    vi.advanceTimersByTime(250);
    const source = MockEventSource.lastInstance!;
    source.simulateOpen();

    client.dispose();
    expect(source.closed).toBe(true);

    source.simulateMessage({
      stream: 'btcusdt@ticker',
      data: { seq: 1 },
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('returns singleton instance from getMarketStreamClient', () => {
    const c1 = getMarketStreamClient();
    const c2 = getMarketStreamClient();
    expect(c1).toBe(c2);
  });
});
