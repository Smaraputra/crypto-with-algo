// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

import {
  analyzeSymbol,
  buildReport,
  closeJumps,
  dayKey,
  dayNumberOf,
  gapRange,
  expectedRange,
  findGaps,
  zeroVolumeRuns,
} from './archive-gaps';

const d = dayNumberOf;

describe('findGaps', () => {
  it('returns the missing days inside the range, ignoring days outside it and duplicates', () => {
    const bars = [d('2022-02-24'), d('2022-02-25'), d('2022-02-25'), d('2022-03-01'), d('2022-03-02'), d('2022-04-30')];
    const gaps = findGaps(bars, { first: d('2022-02-25'), last: d('2022-03-02') });
    expect(gaps.map(dayKey)).toEqual(['2022-02-26', '2022-02-27', '2022-02-28']);
  });

  it('reports nothing for a complete range and everything for an empty one', () => {
    expect(findGaps([1, 2, 3], { first: 1, last: 3 })).toEqual([]);
    expect(findGaps([], { first: 5, last: 7 })).toEqual([5, 6, 7]);
  });

  it('reports leading and trailing gaps', () => {
    expect(findGaps([3], { first: 1, last: 5 })).toEqual([1, 2, 4, 5]);
  });
});

describe('closeJumps', () => {
  const bar = (iso: string, close: number) => ({ day: d(iso), close });

  it('flags ratios above 5 and below 1/5 on adjacent days, and nothing else', () => {
    const jumps = closeJumps([
      bar('2022-05-01', 100),
      bar('2022-05-02', 500), // exactly 5: not above
      bar('2022-05-03', 2600), // 5.2
      bar('2022-05-04', 500), // 0.192
      bar('2022-05-05', 400),
    ]);
    expect(jumps.map((j) => j.day)).toEqual(['2022-05-03', '2022-05-04']);
    expect(jumps[0].ratio).toBeCloseTo(5.2, 10);
    expect(jumps[1].ratio).toBeCloseTo(500 / 2600, 10);
  });

  it('ignores a jump across a gap of missing days (the CONTRACTS rule handles those separately)', () => {
    expect(closeJumps([bar('2022-05-01', 100), bar('2022-05-03', 10000)])).toEqual([]);
  });
});

describe('expectedRange', () => {
  it('runs from the first month start to the last month end, widened by daily files, capped at through', () => {
    const range = expectedRange({ klineMonths: ['2022-02', '2022-03'], dailyKlines: null }, '2026-06-30');
    expect([dayKey(range!.first), dayKey(range!.last)]).toEqual(['2022-02-01', '2022-03-31']);

    const wide = expectedRange(
      { klineMonths: ['2022-02'], dailyKlines: { first: '2022-03-05', last: '2022-03-20', count: 3 } },
      '2026-06-30'
    );
    expect([dayKey(wide!.first), dayKey(wide!.last)]).toEqual(['2022-02-01', '2022-03-20']);

    const capped = expectedRange({ klineMonths: ['2026-05', '2026-06', '2026-07'], dailyKlines: null }, '2026-06-30');
    expect(dayKey(capped!.last)).toBe('2026-06-30');
  });

  it('is null when no 1d file is listed', () => {
    expect(expectedRange({ klineMonths: [], dailyKlines: null }, '2026-06-30')).toBeNull();
  });
});

describe('gapRange', () => {
  const day = (iso: string) => dayNumberOf(iso);

  it('runs from the listing day in the daily file names, not the month start', () => {
    const range = gapRange(
      { klineMonths: ['2021-05', '2021-06'], dailyKlines: { first: '2021-05-10', last: '2021-06-30', count: 52 } },
      [day('2021-05-10'), day('2021-06-30')],
      '2026-06-30'
    );
    expect([dayKey(range!.first), dayKey(range!.last)]).toEqual(['2021-05-10', '2021-06-30']);
  });

  it('never reaches before 2020-01-01 or past `through`', () => {
    const range = gapRange(
      { klineMonths: ['2020-01'], dailyKlines: { first: '2019-12-31', last: '2026-09-30', count: 2465 } },
      [day('2020-01-01'), day('2026-09-30')],
      '2026-06-30'
    );
    expect([dayKey(range!.first), dayKey(range!.last)]).toEqual(['2020-01-01', '2026-06-30']);
  });

  it('falls back to the stored bars without daily files, and is null without bars', () => {
    const range = gapRange({ klineMonths: ['2022-02'], dailyKlines: null }, [day('2022-02-03'), day('2022-02-20')], '2026-06-30');
    expect([dayKey(range!.first), dayKey(range!.last)]).toEqual(['2022-02-03', '2022-02-20']);
    expect(gapRange({ klineMonths: ['2022-02'], dailyKlines: null }, [], '2026-06-30')).toBeNull();
  });
});

describe('analyzeSymbol and buildReport', () => {
  const folder = {
    name: 'SOLUSDT',
    klineMonths: ['2022-02', '2022-03'],
    dailyKlines: { first: '2022-02-26', last: '2022-02-27', count: 2 },
  };
  const everyDay = (from: string, to: string, skip: string[]) => {
    const out: Array<{ day: number; close: number }> = [];
    for (let day = d(from); day <= d(to); day++) if (!skip.includes(dayKey(day))) out.push({ day, close: 100 });
    return out;
  };

  it('splits missing days into repairable and source gaps using the daily listing', async () => {
    const bars = everyDay('2022-02-01', '2022-03-31', ['2022-02-26', '2022-02-27', '2022-03-10']);
    const listDaily = vi.fn(async () => [
      'data/futures/um/daily/klines/SOLUSDT/1d/SOLUSDT-1d-2022-02-26.zip',
      'data/futures/um/daily/klines/SOLUSDT/1d/SOLUSDT-1d-2022-02-26.zip.CHECKSUM',
      'data/futures/um/daily/klines/SOLUSDT/1d/SOLUSDT-1d-2022-02-27.zip',
    ]);
    const result = await analyzeSymbol(folder, bars, listDaily);
    expect(result).toMatchObject({
      symbol: 'SOLUSDT',
      repairDays: ['2022-02-26', '2022-02-27'],
      sourceGapDays: ['2022-03-10'],
      notIngested: false,
    });

    const { report, repairFile } = buildReport('abc', '2026-06-30', [result!]);
    expect(repairFile).toEqual([{ symbol: 'SOLUSDT', klineDays: ['2022-02-26', '2022-02-27'] }]);
    expect(report.sourceGaps).toEqual([{ symbol: 'SOLUSDT', days: ['2022-03-10'] }]);
    expect(report.counts).toMatchObject({ symbolsChecked: 1, symbolsWithGaps: 1, repairDays: 2, sourceGapDays: 1 });
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not list the archive for a clean symbol', async () => {
    const listDaily = vi.fn(async () => []);
    const result = await analyzeSymbol(folder, everyDay('2022-02-01', '2022-03-31', []), listDaily);
    expect(listDaily).not.toHaveBeenCalled();
    expect(result).toMatchObject({ repairDays: [], sourceGapDays: [] });
  });

  it('reports a symbol with no stored bars as not ingested, not as thousands of gaps', async () => {
    const listDaily = vi.fn(async () => []);
    const result = await analyzeSymbol(folder, [], listDaily);
    expect(result).toMatchObject({ notIngested: true, repairDays: [], sourceGapDays: [] });
    expect(listDaily).not.toHaveBeenCalled();
    expect(buildReport('abc', '2026-06-30', [result!]).report.notIngested).toEqual(['SOLUSDT']);
  });

  it('carries close jumps into the report with symbol, day and ratio', async () => {
    const bars = [
      { day: d('2022-02-01'), close: 1 },
      { day: d('2022-02-02'), close: 1000 },
    ];
    const result = await analyzeSymbol(
      { name: 'XUSDT', klineMonths: [], dailyKlines: { first: '2022-02-01', last: '2022-02-02', count: 2 } },
      bars,
      async () => []
    );
    expect(buildReport('abc', '2026-06-30', [result!]).report.jumps).toEqual([
      { symbol: 'XUSDT', day: '2022-02-02', ratio: 1000 },
    ]);
  });
});

describe('zero-volume days', () => {
  it('groups consecutive zero-volume days into runs', () => {
    const days = ['2025-07-01', '2025-07-02', '2025-07-03', '2025-07-09'].map(d);
    expect(zeroVolumeRuns(days)).toEqual([
      { start: '2025-07-01', end: '2025-07-03', length: 3 },
      { start: '2025-07-09', end: '2025-07-09', length: 1 },
    ]);
    expect(zeroVolumeRuns([])).toEqual([]);
  });

  it('reports them apart from gaps, never as repairs, and ignores them for close jumps', async () => {
    const folder = { name: 'CVXUSDT', klineMonths: ['2025-07'], dailyKlines: null };
    const bars: Array<{ day: number; close: number; volume: number }> = [];
    for (let day = d('2025-07-01'); day <= d('2025-07-31'); day++) {
      const halted = day <= d('2025-07-30');
      bars.push({ day, close: halted ? 2.374 : 20, volume: halted ? 0 : 5 });
    }
    const listDaily = vi.fn(async () => []);
    const result = await analyzeSymbol(folder, bars, listDaily, '2026-06-30');
    expect(listDaily).not.toHaveBeenCalled();
    expect(result).toMatchObject({ repairDays: [], sourceGapDays: [], jumps: [] });
    expect(result!.zeroVolumeDays).toHaveLength(30);
    expect(result!.zeroVolumeRuns).toEqual([{ start: '2025-07-01', end: '2025-07-30', length: 30 }]);

    const { report, repairFile } = buildReport('abc', '2026-06-30', [result!]);
    expect(repairFile).toEqual([]);
    expect(report.zeroVolume).toEqual([
      { symbol: 'CVXUSDT', days: result!.zeroVolumeDays, runs: result!.zeroVolumeRuns },
    ]);
    expect(report.counts.zeroVolumeDays).toBe(30);
  });
});
