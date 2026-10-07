// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';

import {
  BENCHMARK_SYMBOL,
  basketSpans,
  buildBroadInputs,
  contractCalendar,
  dueDay,
  fundingCheckDays,
  loadBroadInputs,
  missingSettlements,
  preregisteredParameters,
  universeSpans,
  verifyUniverseFile,
} from './broad-inputs';
import { SMALL_OPTIONS, SMALL_SPECS, syntheticBroadInputs, syntheticUniverse, writeSyntheticExport } from './broad-fixtures';
import { DAY_MS, dayStartMs, segmentContracts, universeFile, type Membership } from './broad-trend';
import type { FundingRow, PerpCandleRow } from './dataset-format';
import type { TrendSymbolInput } from './trend-sim';

const H = 3_600_000;
const utc = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h);

function bar(t: number, c: number, v = 10): PerpCandleRow {
  return { t, o: c, h: c, l: c, c, v, qv: 1000, n: 1, tbv: null };
}

describe('contractCalendar', () => {
  it('fills a missing or zero-volume day inside a contract as a carried day of the last close', () => {
    const d0 = utc(2022, 1, 1);
    const rows = [bar(d0, 10), bar(d0 + DAY_MS, 11), bar(d0 + 2 * DAY_MS, 99, 0), bar(d0 + 4 * DAY_MS, 12), bar(d0 + 5 * DAY_MS, 13)];
    const [contract] = segmentContracts('XUSDT', rows);
    const cal = contractCalendar(contract);
    expect(cal.t).toEqual([0, 1, 2, 3, 4, 5].map((k) => d0 + k * DAY_MS));
    expect(cal.close).toEqual([10, 11, 11, 11, 12, 13]);
    expect(cal.open).toEqual([10, 11, 11, 11, 12, 13]);
    expect(Array.from(cal.carried)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(cal.carriedDays).toBe(2);
  });
});

describe('universeSpans and basketSpans', () => {
  const membership = {
    months: [
      { close: '2021-03-01', closeMs: utc(2021, 3, 1), validUntil: '2021-04-01', members: [{ id: 'A#1', rank: 1 }, { id: 'B#1', rank: 2 }] },
      { close: '2021-04-01', closeMs: utc(2021, 4, 1), validUntil: '2021-05-01', members: [{ id: 'B#1', rank: 1 }] },
    ],
  } as unknown as Membership;

  it('gives each contract its months, close to the next close, with its rank at the close', () => {
    expect(universeSpans(membership)).toEqual({
      'A#1': [{ from: utc(2021, 3, 1), to: utc(2021, 4, 1), rank: 1 }],
      'B#1': [
        { from: utc(2021, 3, 1), to: utc(2021, 4, 1), rank: 2 },
        { from: utc(2021, 4, 1), to: utc(2021, 5, 1), rank: 1 },
      ],
    });
    expect(basketSpans(membership)['B#1']).toEqual([
      { from: utc(2021, 3, 1), to: utc(2021, 4, 1) },
      { from: utc(2021, 4, 1), to: utc(2021, 5, 1) },
    ]);
  });

  it('refuses a month whose closeMs disagrees with its close', () => {
    const bad = { months: [{ ...membership.months[0], closeMs: utc(2021, 3, 2) }] } as unknown as Membership;
    expect(() => universeSpans(bad)).toThrow(/closeMs/);
  });
});

describe('verifyUniverseFile', () => {
  const u = syntheticUniverse();
  const json = () => JSON.parse(JSON.stringify(u.universe)) as Record<string, unknown>;

  it('accepts the file built from this export, its sha256 recomputing after a JSON round trip', () => {
    expect(verifyUniverseFile(json(), u.datasetHash, { preregistered: false }).sha256).toBe(u.universe.sha256);
  });

  it('refuses a tampered file, another export and a non-pre-registered universe when asked', () => {
    const tampered = json();
    (tampered.universe as Membership).months[0].members.reverse();
    expect(() => verifyUniverseFile(tampered, u.datasetHash, { preregistered: false })).toThrow(/does not recompute/);
    expect(() => verifyUniverseFile(json(), 'another', { preregistered: false })).toThrow(/built from export synthetic-export, not another/);
    expect(() => verifyUniverseFile(json(), u.datasetHash, { preregistered: true })).toThrow(/pre-registered/);
    expect(() => verifyUniverseFile({ sha256: 'x' }, u.datasetHash, { preregistered: false })).toThrow(/sha256 or sourceDatasetHash/);
  });

  it('accepts the pre-registered parameters exactly as universeFile writes them', () => {
    const rows = Array.from({ length: 30 }, (_, k) => bar(utc(2020, 1, 1) + k * DAY_MS, 1));
    const file = universeFile({ sourceDatasetHash: 'h', contracts: segmentContracts('AUSDT', rows) });
    expect(file.parameters).toEqual(preregisteredParameters());
    // That tiny universe never reaches 20 eligible contracts: no sample.
    expect(() => verifyUniverseFile(JSON.parse(JSON.stringify(file)), 'h', { preregistered: true })).toThrow(/no sample/);
  });
});

describe('missingSettlements (header DATA: every settlement due on a member day must exist)', () => {
  const firstDay = utc(2022, 1, 1);
  const lastDay = utc(2022, 1, 10);
  const grid = (h: number, from = firstDay + h * H, to = lastDay + DAY_MS, skip: number[] = []): FundingRow[] => {
    const out: FundingRow[] = [];
    for (let t = from; t <= to; t += h * H) if (!skip.includes(t)) out.push({ t, rate: 0.0001, intervalHours: h });
    return out;
  };
  const days = (...ds: number[]) => new Set(ds.map((d) => utc(2022, 1, d)));
  const contract = { id: 'X#1', firstDay, lastDay, endDay: null };

  it('finds nothing on a complete grid, and a gap inside it on a member day', () => {
    expect(missingSettlements(contract, grid(8), days(3, 4, 5))).toEqual([]);
    const gap = grid(8, undefined, undefined, [utc(2022, 1, 4, 16)]);
    expect(missingSettlements(contract, gap, days(3, 4, 5))).toEqual([{ contract: 'X#1', t: utc(2022, 1, 4, 16), reason: 'missing' }]);
    // The next day's 00:00 settlement is charged on the day before.
    const midnight = grid(8, undefined, undefined, [utc(2022, 1, 5)]);
    expect(missingSettlements(contract, midnight, days(4))).toHaveLength(1);
    expect(missingSettlements(contract, midnight, days(5))).toHaveLength(0);
  });

  it('ignores a gap on a day that is not checked (not a member day, or carried)', () => {
    const gap = grid(8, undefined, undefined, [utc(2022, 1, 4, 16)]);
    expect(missingSettlements(contract, gap, days(3, 5))).toEqual([]);
  });

  it('reads each row\'s own interval, so a switch from 8h to 4h is complete and a missing 4h settlement is found', () => {
    const switched = [...grid(8, firstDay + 8 * H, utc(2022, 1, 5)), ...grid(4, utc(2022, 1, 5, 4))];
    expect(missingSettlements(contract, switched, days(2, 3, 4, 5, 6, 7, 8, 9))).toEqual([]);
    const lacking = switched.filter((r) => r.t !== utc(2022, 1, 6, 12));
    expect(missingSettlements(contract, lacking, days(6)).map((m) => m.t)).toEqual([utc(2022, 1, 6, 12)]);
  });

  it('extends the grid before the first row and after the last, except on the listing day', () => {
    const late = grid(8, utc(2022, 1, 3, 8));
    // 2022-01-02 16:00 and 2022-01-03 00:00 are due on 01-02; 01-01's own settlements are not due (it lists that day).
    expect(missingSettlements(contract, late, days(1, 2)).map((m) => m.t)).toEqual([utc(2022, 1, 2, 8), utc(2022, 1, 2, 16), utc(2022, 1, 3)]);
    const early = grid(8, undefined, utc(2022, 1, 9, 16));
    expect(missingSettlements(contract, early, days(9, 10)).map((m) => m.t)).toEqual([utc(2022, 1, 10), utc(2022, 1, 10, 8), utc(2022, 1, 10, 16), utc(2022, 1, 11)]);
  });

  it('does not require settlements after the last one on a delisted contract\'s end day', () => {
    const delisted = { ...contract, endDay: lastDay };
    const stopped = grid(8, undefined, utc(2022, 1, 10, 8));
    expect(missingSettlements(delisted, stopped, days(9, 10))).toEqual([]);
    // Inside the day the gaps still count.
    const holed = stopped.filter((r) => r.t !== utc(2022, 1, 10));
    expect(missingSettlements(delisted, holed, days(9, 10)).map((m) => m.t)).toEqual([utc(2022, 1, 10)]);
  });

  it('does not require the lockbox settlement at 2026-07-01 00:00 on the last sample day', () => {
    const c = { id: 'Y#1', firstDay: utc(2026, 6, 25), lastDay: utc(2026, 6, 30), endDay: null };
    const rows = grid(8, utc(2026, 6, 25, 8), utc(2026, 6, 30, 16));
    expect(missingSettlements(c, rows, new Set([utc(2026, 6, 29), utc(2026, 6, 30)]))).toEqual([]);
  });

  it('reports a stretch without a stated interval that touches a checked day, and a contract without settlements', () => {
    const rows = grid(8).map((r) => (r.t === utc(2022, 1, 4, 8) ? { ...r, intervalHours: null } : r));
    expect(missingSettlements(contract, rows, days(4))).toEqual([{ contract: 'X#1', t: utc(2022, 1, 4, 8), reason: 'interval-unknown' }]);
    expect(missingSettlements(contract, rows, days(7))).toEqual([]);
    expect(missingSettlements(contract, [], days(4))[0].reason).toBe('no-settlements');
    expect(missingSettlements(contract, [], new Set())).toEqual([]);
  });

  it('dueDay maps (d, d + 1 day] to d', () => {
    expect(dueDay(utc(2022, 1, 2))).toBe(utc(2022, 1, 1));
    expect(dueDay(utc(2022, 1, 2, 8))).toBe(utc(2022, 1, 2));
  });
});

describe('fundingCheckDays', () => {
  const d0 = utc(2021, 2, 20);
  const n = 50;
  const carried = new Uint8Array(n);
  carried[15] = 1;
  const input: TrendSymbolInput = {
    symbol: 'X#1',
    t: Array.from({ length: n }, (_, k) => d0 + k * DAY_MS),
    open: new Array(n).fill(1),
    close: new Array(n).fill(1),
    listingDay: d0,
    settlements: [],
    carried,
    membership: [{ from: utc(2021, 3, 1), to: utc(2021, 4, 1), rank: 3 }],
  };

  it('is the real member days plus the day the membership ends, while the contract trades', () => {
    const days = fundingCheckDays(input, utc(2021, 3, 1), utc(2021, 5, 1));
    // 2021-03-07 (index 15) is carried; 2021-04-01 is the exit day.
    expect(days.size).toBe(31 - 1 + 1);
    expect(days.has(utc(2021, 3, 7))).toBe(false);
    expect(days.has(utc(2021, 4, 1))).toBe(true);
    expect(days.has(utc(2021, 4, 2))).toBe(false);
    expect(fundingCheckDays(input, utc(2021, 3, 1), utc(2021, 5, 1), true).size).toBe(n - 9 - 1);
  });
});

describe('buildBroadInputs on a synthetic universe', () => {
  const inputs = syntheticBroadInputs();

  it('builds one input per contract, keyed by contract id, members and basket members sorted', () => {
    expect(inputs.contracts.map((c) => c.id)).toEqual(
      expect.arrayContaining(['AAAUSDT#1', 'BBBUSDT#1', 'BTCUSDT#1', 'CCCUSDT#1', 'DDDUSDT#1', 'ETHUSDT#1', 'SOLUSDT#1'])
    );
    expect(inputs.inputs.map((i) => i.symbol)).toEqual([...inputs.inputs.map((i) => i.symbol)].sort());
    for (const input of inputs.inputs) expect(input.membership!.length).toBeGreaterThan(0);
    expect(inputs.from).toBe(dayStartMs(inputs.universe.universe.startClose!));
    expect(inputs.to).toBe(utc(2026, 7, 1));
    expect(inputs.lockboxApplied).toBe(true);
    // The basket reaches back to 2020-02-01 and holds contracts the universe never does (DDD's second contract).
    expect(Math.min(...Object.values(inputs.basketMembership).flat().map((s) => s.from))).toBe(utc(2020, 2, 1));
  });

  it('carries a short halt inside a contract and splits a long one into two contracts', () => {
    const ccc = inputs.contracts.find((c) => c.id === 'CCCUSDT#1')!;
    expect(ccc.carriedDays).toBe(3);
    const cccInput = [...inputs.inputs, ...inputs.basketInputs].find((i) => i.symbol === 'CCCUSDT#1')!;
    expect(cccInput.carried!.reduce((s, f) => s + f, 0)).toBe(3);
    const ddd = inputs.contracts.filter((c) => c.symbol === 'DDDUSDT');
    expect(ddd.map((c) => c.id)).toEqual(['DDDUSDT#1', 'DDDUSDT#2']);
    expect(ddd[0].endDay).toBe(ddd[0].lastDay);
    expect(ddd[1].endDay).toBeNull();
    expect(inputs.contracts.find((c) => c.id === 'BBBUSDT#1')!.endDay).toBe(utc(2023, 5, 10));
  });

  it('reads settlements within each member contract\'s life only, at its own interval', () => {
    for (const input of inputs.inputs) {
      const first = input.t[0];
      const last = input.t[input.t.length - 1];
      expect(input.settlements.every((s) => s.t > first && s.t <= last + DAY_MS)).toBe(true);
    }
    expect(inputs.funding.byInterval['4'] ?? 0).toBeGreaterThan(0);
    expect(inputs.funding.contracts).toBe(inputs.inputs.length);
  });

  it('stops before any return when a settlement due on a member day is missing, naming the symbol and the time', () => {
    const btc = inputs.inputs.find((i) => i.symbol === 'BTCUSDT#1')!;
    const day = btc.membership![2].from + 5 * DAY_MS;
    const specs = SMALL_SPECS.map((s) => (s.symbol === 'BTCUSDT' ? { ...s, dropSettlements: [day + 16 * H] } : s));
    expect(() => syntheticBroadInputs(syntheticUniverse(specs))).toThrow(
      new RegExp(`1 funding settlement.*BTCUSDT \\(BTCUSDT#1\\) ${new Date(day + 16 * H).toISOString()} missing`)
    );
  });

  it('checks the BTC benchmark\'s funding on every sample day, and no other contract off its member days', () => {
    expect(BENCHMARK_SYMBOL).toBe('BTCUSDT');
    // A settlement missing in 2020 (before the sample) stops nothing.
    const early = SMALL_SPECS.map((s) => (s.symbol === 'AAAUSDT' ? { ...s, dropSettlements: [utc(2020, 6, 1, 8)] } : s));
    expect(() => syntheticBroadInputs(syntheticUniverse(early))).not.toThrow();
  });

  it('refuses a contract whose bars differ from the universe file\'s metadata', () => {
    const u = syntheticUniverse();
    const perp: Record<string, PerpCandleRow[]> = { ...u.perp, BTCUSDT: u.perp.BTCUSDT.slice(0, -1) };
    expect(() =>
      buildBroadInputs({
        datasetHash: u.datasetHash,
        universe: u.universe,
        perp: (s) => ({ rows: perp[s], lockboxApplied: true }),
        funding: (s) => ({ rows: u.funding[s], lockboxApplied: true }),
      })
    ).toThrow(/BTCUSDT#1 in the export differs/);
  });
});

describe('loadBroadInputs from an export directory', () => {
  let dir: string;
  let universePath: string;
  let hash: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'broad-inputs-'));
    const u = syntheticUniverse();
    hash = await writeSyntheticExport(join(dir, 'export'), u);
    const contracts = SMALL_SPECS.flatMap((s) => segmentContracts(s.symbol, u.perp[s.symbol]));
    const file = universeFile({ sourceDatasetHash: hash, contracts, universe: SMALL_OPTIONS.universe, basket: SMALL_OPTIONS.basket });
    universePath = join(dir, 'universe.json');
    writeFileSync(universePath, `${JSON.stringify(file, null, 1)}\n`);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('verifies the manifest and the universe file, then builds the same inputs as in memory', async () => {
    const loaded = await loadBroadInputs(join(dir, 'export'), universePath, { preregistered: false });
    expect(loaded.datasetHash).toBe(hash);
    const memory = syntheticBroadInputs({ ...syntheticUniverse(), datasetHash: hash, universe: loaded.universe });
    expect(loaded.inputs.map((i) => [i.symbol, i.t.length, i.settlements.length])).toEqual(
      memory.inputs.map((i) => [i.symbol, i.t.length, i.settlements.length])
    );
    await expect(loadBroadInputs(join(dir, 'export'), universePath)).rejects.toThrow(/pre-registered/);
  });

  it('refuses a tampered export file', async () => {
    const path = join(dir, 'export', 'perp', 'AAAUSDT', '1d.jsonl.gz');
    writeFileSync(path, gzipSync('{"t":0}\n'));
    await expect(loadBroadInputs(join(dir, 'export'), universePath, { preregistered: false })).rejects.toThrow(
      /Manifest verification failed: perp\/AAAUSDT\/1d.jsonl.gz/
    );
  });
});
