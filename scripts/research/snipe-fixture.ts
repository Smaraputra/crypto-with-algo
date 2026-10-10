/** Test-support: a small synthetic perp dataset in the export format, crossing the lockbox start. */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type DatasetManifest,
  type ManifestFile,
  type PerpCandleRow,
  type SnapshotRow,
} from './dataset-format';

export const FIXTURE_START = Date.UTC(2026, 2, 1);
export const FIXTURE_5M_BARS = 36_000; // 125 days, ends 2026-07-04 (past the lockbox start)
const FIVE = 300_000;

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function aggregate(rows: PerpCandleRow[], factor: number): PerpCandleRow[] {
  const out: PerpCandleRow[] = [];
  for (let i = 0; i + factor <= rows.length; i += factor) {
    const g = rows.slice(i, i + factor);
    out.push({
      t: g[0].t,
      o: g[0].o,
      h: Math.max(...g.map((r) => r.h)),
      l: Math.min(...g.map((r) => r.l)),
      c: g[g.length - 1].c,
      v: g.reduce((a, r) => a + r.v, 0),
      qv: g.reduce((a, r) => a + r.qv, 0),
      n: g.reduce((a, r) => a + r.n, 0),
      tbv: g.reduce((a, r) => a + (r.tbv ?? 0), 0),
    });
  }
  return out;
}

export function perpSeries5m(seed: number, count = FIXTURE_5M_BARS): PerpCandleRow[] {
  const next = rng(seed);
  const rows: PerpCandleRow[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const o = price;
    const c = o * (1 + (next() - 0.5) * 0.004);
    const h = Math.max(o, c) * (1 + next() * 0.001);
    const l = Math.min(o, c) * (1 - next() * 0.001);
    const v = 1000 + next() * 500;
    rows.push({ t: FIXTURE_START + i * FIVE, o, h, l, c, v, qv: v * c, n: 100, tbv: v * (0.4 + next() * 0.2) });
    price = c;
  }
  return rows;
}

/** Writes perp 5m/1h/4h klines and 1h snapshots per symbol plus a verifying manifest. */
export async function writeSnipeFixture(dir: string, symbols: string[], seeds: number[]): Promise<DatasetManifest> {
  const files: ManifestFile[] = [];
  const put = async (rel: string, kind: ManifestFile['kind'], symbol: string, interval: string, rows: Array<{ t: number }>) => {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    await writeJsonlGz(path, rows);
    files.push({
      path: rel,
      kind,
      symbol,
      interval,
      rowCount: rows.length,
      startMs: rows.length ? rows[0].t : null,
      endMs: rows.length ? rows[rows.length - 1].t : null,
      sha256: await sha256File(path),
    });
  };
  for (const [i, symbol] of symbols.entries()) {
    const r5 = perpSeries5m(seeds[i]);
    const r1h = aggregate(r5, 12);
    const r4h = aggregate(r1h, 4);
    await put(`perp/${symbol}/5m.jsonl.gz`, 'perp', symbol, '5m', r5);
    await put(`perp/${symbol}/1h.jsonl.gz`, 'perp', symbol, '1h', r1h);
    await put(`perp/${symbol}/4h.jsonl.gz`, 'perp', symbol, '4h', r4h);
    const snaps: SnapshotRow[] = r1h.map((r, k) => ({
      t: r.t,
      fundingRate: { rate: -0.001 + (k % 7) * 0.0003, markPrice: r.c },
      longShortRatio: null,
      openInterest: null,
      fearGreed: { index: 20 + (k % 60), label: 'x' },
      newsSentiment: null,
    }));
    await put(`snapshots/${symbol}/1h.jsonl.gz`, 'snapshots', symbol, '1h', snaps);
  }
  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: 'test-fixture',
    lockboxStart: LOCKBOX_START_ISO,
    symbols,
    intervals: ['5m', '1h', '4h'],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
