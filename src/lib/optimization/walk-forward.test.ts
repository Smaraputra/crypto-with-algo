import { describe, it, expect } from 'vitest';
import { calculateWindows, deriveStepSize } from './walk-forward';
import { DEFAULT_OPTIMIZATION_CONFIG } from '@/types/optimization';

describe('calculateWindows', () => {
  it('produces correct number of windows for standard input', () => {
    // 1000 bars, 500 train, 100 test, 100 step
    const windows = calculateWindows(1000, 500, 100, 100);

    // trainEnd starts at 499, each step adds 100
    // Window 1: trainEnd=499, testStart=500, testEnd=599 (500+100<1000)
    // Window 2: trainEnd=599, testStart=600, testEnd=699 (600+100<1000)
    // Window 3: trainEnd=699, testStart=700, testEnd=799 (700+100<1000)
    // Window 4: trainEnd=799, testStart=800, testEnd=899 (800+100<1000)
    // Window 5: trainEnd=899, testStart=900, testEnd=999 (900+100<1000? 900+100=1000, not < 1000)
    // Actually: while (trainEnd + testWindowBars < totalBars), 899+100=999 < 1000, so window 5 exists
    // Window 6: trainEnd=999, 999+100=1099 >= 1000, stop
    expect(windows).toHaveLength(5);
  });

  it('returns 1 window when totalBars equals minTraining + testWindow', () => {
    // Exact minimum: 600 bars = 500 train + 100 test
    const windows = calculateWindows(600, 500, 100, 100);

    // trainEnd=499, 499+100=599 < 600, so 1 window
    // Next: trainEnd=599, 599+100=699 >= 600, stop
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual({
      trainStart: 0,
      trainEnd: 499,
      testStart: 500,
      testEnd: 599,
    });
  });

  it('returns 0 windows when totalBars < minTraining + testWindow', () => {
    const windows = calculateWindows(400, 500, 100, 100);
    expect(windows).toHaveLength(0);
  });

  it('all windows are anchored at trainStart === 0', () => {
    const windows = calculateWindows(2000, 500, 100, 100);
    expect(windows.length).toBeGreaterThan(1);

    for (const w of windows) {
      expect(w.trainStart).toBe(0);
    }
  });

  it('each window trainEnd grows by stepSize (expanding)', () => {
    const stepSize = 100;
    const windows = calculateWindows(2000, 500, 100, stepSize);
    expect(windows.length).toBeGreaterThan(1);

    for (let i = 1; i < windows.length; i++) {
      expect(windows[i].trainEnd - windows[i - 1].trainEnd).toBe(stepSize);
    }
  });

  it('testEnd never exceeds totalBars - 1', () => {
    const totalBars = 1000;
    const windows = calculateWindows(totalBars, 300, 150, 50);

    for (const w of windows) {
      expect(w.testEnd).toBeLessThanOrEqual(totalBars - 1);
    }
  });

  it('test window immediately follows training window', () => {
    const windows = calculateWindows(1500, 400, 200, 100);

    for (const w of windows) {
      expect(w.testStart).toBe(w.trainEnd + 1);
    }
  });

  it('handles step size of 1 (many small windows)', () => {
    const windows = calculateWindows(110, 100, 5, 1);

    // trainEnd starts at 99, step 1
    // Window 1: trainEnd=99, 99+5=104 < 110
    // Window 2: trainEnd=100, 100+5=105 < 110
    // ...
    // Window 5: trainEnd=103, 103+5=108 < 110
    // Window 6: trainEnd=104, 104+5=109 < 110
    // Window 7: trainEnd=105, 105+5=110, NOT < 110, stop
    expect(windows).toHaveLength(6);
  });
});

describe('deriveStepSize', () => {
  const MIN_TRAINING = DEFAULT_OPTIMIZATION_CONFIG.minTrainingBars;
  const TEST_WINDOW = DEFAULT_OPTIMIZATION_CONFIG.testWindowBars;
  const TARGET = 6;

  function windowCount(totalBars: number, targetWindows = TARGET): number {
    const step = deriveStepSize(totalBars, MIN_TRAINING, TEST_WINDOW, targetWindows);
    return calculateWindows(totalBars, MIN_TRAINING, TEST_WINDOW, step).length;
  }

  it('bounds the window count for a three-month 5m series', () => {
    // 3 months at 5m. A fixed 300-bar step yielded ~85 windows here.
    const bars = 3 * 30 * 24 * 12;

    expect(calculateWindows(bars, MIN_TRAINING, TEST_WINDOW, 300).length).toBeGreaterThan(80);
    expect(windowCount(bars)).toBeLessThanOrEqual(TARGET + 1);
  });

  it('produces multiple windows for a 48-month daily series', () => {
    // 4 years at 1d. A fixed 300-bar step yielded a single window here.
    const bars = 48 * 30;

    expect(calculateWindows(bars, MIN_TRAINING, TEST_WINDOW, 300).length).toBe(4);
    expect(windowCount(bars)).toBeGreaterThan(1);
    expect(windowCount(bars)).toBeLessThanOrEqual(TARGET + 1);
  });

  it('keeps the count near target across two orders of magnitude of series length', () => {
    for (const bars of [600, 1440, 4320, 8640, 25920]) {
      const count = windowCount(bars);

      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(TARGET + 1);
    }
  });

  it('never returns a step below 1', () => {
    expect(deriveStepSize(401, MIN_TRAINING, TEST_WINDOW, 100)).toBeGreaterThanOrEqual(1);
  });

  it('falls back to the test window when the series cannot be stepped', () => {
    expect(deriveStepSize(400, MIN_TRAINING, TEST_WINDOW, TARGET)).toBe(TEST_WINDOW);
    expect(deriveStepSize(200, MIN_TRAINING, TEST_WINDOW, TARGET)).toBe(TEST_WINDOW);
  });

  it('rejects a target below one window', () => {
    expect(() => deriveStepSize(5000, MIN_TRAINING, TEST_WINDOW, 0)).toThrow('at least 1');
  });
});
