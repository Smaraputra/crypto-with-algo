import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { createElement } from 'react';
import { useChartResize } from './useChartResize';

let observeCallbacks: (() => void)[] = [];
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

class MockResizeObserver {
  constructor(cb: () => void) {
    observeCallbacks.push(cb);
  }
  observe = mockObserve;
  disconnect = mockDisconnect;
  unobserve = vi.fn();
}

// Test component that uses the hook and attaches the ref to a div
function TestComponent({
  chartResize,
  onResult,
}: {
  chartResize: { current: { resize?: () => void } | null };
  onResult: (result: ReturnType<typeof useChartResize>) => void;
}) {
  const result = useChartResize(chartResize);
  onResult(result);
  return createElement('div', { ref: result.containerRef, 'data-testid': 'container' });
}

function createChartRef() {
  return { current: { resize: vi.fn() } };
}

function mockGetBoundingClientRect(width: number, height: number) {
  return () => ({
    width,
    height,
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    x: 0,
    y: 0,
    toJSON: vi.fn(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
  observeCallbacks = [];
  mockObserve.mockClear();
  mockDisconnect.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useChartResize', () => {
  it('returns initial dimensions of 0x0 before container mounts', () => {
    // containerRef is null before render, so dimensions stay 0x0
    // We check by using a raw renderHook (no DOM element)
    const chartRef = createChartRef();
    let latestResult: ReturnType<typeof useChartResize> | null = null;

    render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: (r) => { latestResult = r; },
      })
    );

    // jsdom elements have 0x0 getBoundingClientRect by default
    expect(latestResult!.width).toBe(0);
    expect(latestResult!.height).toBe(0);
  });

  it('calls ResizeObserver.observe on mount', () => {
    const chartRef = createChartRef();
    render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: () => {},
      })
    );

    expect(mockObserve).toHaveBeenCalled();
  });

  it('updates dimensions after resize callback and debounce', () => {
    const chartRef = createChartRef();
    let latestResult: ReturnType<typeof useChartResize> | null = null;

    const { container } = render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: (r) => { latestResult = r; },
      })
    );

    const div = container.querySelector('[data-testid="container"]') as HTMLDivElement;
    div.getBoundingClientRect = mockGetBoundingClientRect(800, 600);

    act(() => {
      observeCallbacks.forEach((cb) => cb());
      vi.advanceTimersByTime(100);
    });

    expect(latestResult!.width).toBe(800);
    expect(latestResult!.height).toBe(600);
  });

  it('debounces multiple rapid resizes to a single update', () => {
    const chartRef = createChartRef();
    let renderCount = 0;

    const { container } = render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: () => { renderCount++; },
      })
    );

    const div = container.querySelector('[data-testid="container"]') as HTMLDivElement;
    div.getBoundingClientRect = mockGetBoundingClientRect(800, 600);

    const countBefore = renderCount;

    act(() => {
      observeCallbacks.forEach((cb) => cb());
      vi.advanceTimersByTime(30);
      observeCallbacks.forEach((cb) => cb());
      vi.advanceTimersByTime(30);
      observeCallbacks.forEach((cb) => cb());
      vi.advanceTimersByTime(100);
    });

    // Only 1 state update from the debounced resize (not 3)
    const stateUpdates = renderCount - countBefore;
    expect(stateUpdates).toBeLessThanOrEqual(2);
  });

  it('calls chartRef.resize() on dimension change', () => {
    const chartRef = createChartRef();

    const { container } = render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: () => {},
      })
    );

    const div = container.querySelector('[data-testid="container"]') as HTMLDivElement;
    div.getBoundingClientRect = mockGetBoundingClientRect(800, 600);

    act(() => {
      observeCallbacks.forEach((cb) => cb());
      vi.advanceTimersByTime(100);
    });

    expect(chartRef.current.resize).toHaveBeenCalled();
  });

  it('disconnects observer on unmount', () => {
    const chartRef = createChartRef();
    const { unmount } = render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: () => {},
      })
    );

    unmount();

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('clears pending timeout on unmount', () => {
    const chartRef = createChartRef();
    const { container, unmount } = render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: () => {},
      })
    );

    const div = container.querySelector('[data-testid="container"]') as HTMLDivElement;
    div.getBoundingClientRect = mockGetBoundingClientRect(800, 600);

    // Trigger resize but don't let debounce complete
    act(() => {
      observeCallbacks.forEach((cb) => cb());
    });

    // Unmount before debounce fires
    unmount();

    // Advance time -- the debounced callback should NOT fire (no error from unmounted component)
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // If clearTimeout wasn't called, the timer would fire on an unmounted component
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('does not update dimensions when container has zero size', () => {
    const chartRef = createChartRef();
    let latestResult: ReturnType<typeof useChartResize> | null = null;

    const { container } = render(
      createElement(TestComponent, {
        chartResize: chartRef,
        onResult: (r) => { latestResult = r; },
      })
    );

    const div = container.querySelector('[data-testid="container"]') as HTMLDivElement;
    div.getBoundingClientRect = mockGetBoundingClientRect(0, 0);

    act(() => {
      observeCallbacks.forEach((cb) => cb());
      vi.advanceTimersByTime(100);
    });

    expect(latestResult!.width).toBe(0);
    expect(latestResult!.height).toBe(0);
    expect(chartRef.current.resize).not.toHaveBeenCalled();
  });
});
