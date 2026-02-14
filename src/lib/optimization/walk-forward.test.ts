import { describe, it, expect } from 'vitest';
import { calculateWindows } from './walk-forward';

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
