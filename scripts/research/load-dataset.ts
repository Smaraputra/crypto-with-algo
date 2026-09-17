/**
 * Loads the research dataset exported by export-dataset.ts. Research
 * subagents read the dataset through these functions instead of touching
 * Mongo, so every consumer sees one identical, hashed dataset with the
 * lockbox window (2026-07-01 onward) held out by default.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LOCKBOX_START,
  datasetHashOf,
  readJsonlGz,
  sha256File,
  type CandleRow,
  type DatasetManifest,
  type HtfRow,
  type ManifestFile,
  type SnapshotRow,
} from './dataset-format';

export function loadManifest(dir: string): DatasetManifest {
  const raw = readFileSync(join(dir, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as DatasetManifest;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: string[];
}

/**
 * Recomputes every listed file's sha256 and the dataset hash built from
 * those live values, so both a tampered file and a manifest whose recorded
 * hash no longer matches its own file list are reported.
 */
export async function verifyManifest(dir: string): Promise<VerifyResult> {
  const manifest = loadManifest(dir);
  const mismatches: string[] = [];
  const actual: ManifestFile[] = [];

  for (const file of manifest.files) {
    const actualSha256 = await sha256File(join(dir, file.path));
    if (actualSha256 !== file.sha256) {
      mismatches.push(file.path);
    }
    actual.push({ ...file, sha256: actualSha256 });
  }

  if (datasetHashOf(actual) !== manifest.datasetHash) {
    mismatches.push('manifest.json');
  }

  return { ok: mismatches.length === 0, mismatches };
}

export interface LoadOptions {
  /** Pass true to read data from the lockbox window (2026-07-01 onward). */
  allowLockbox?: boolean;
}

export interface LoadResult<T> {
  rows: T[];
  lockboxApplied: boolean;
  lockboxStart: number;
  droppedRows: number;
}

function applyLockbox<T extends { t: number }>(
  rows: T[],
  opts: LoadOptions
): LoadResult<T> {
  if (opts.allowLockbox) {
    return { rows, lockboxApplied: false, lockboxStart: LOCKBOX_START, droppedRows: 0 };
  }

  const kept = rows.filter((row) => row.t < LOCKBOX_START);
  return {
    rows: kept,
    lockboxApplied: true,
    lockboxStart: LOCKBOX_START,
    droppedRows: rows.length - kept.length,
  };
}

export function loadCandles(
  dir: string,
  symbol: string,
  interval: string,
  opts: LoadOptions = {}
): LoadResult<CandleRow> {
  const path = join(dir, 'candles', symbol, `${interval}.jsonl.gz`);
  return applyLockbox(readJsonlGz<CandleRow>(path), opts);
}

export function loadSnapshots(
  dir: string,
  symbol: string,
  interval: string,
  opts: LoadOptions = {}
): LoadResult<SnapshotRow> {
  const path = join(dir, 'snapshots', symbol, `${interval}.jsonl.gz`);
  return applyLockbox(readJsonlGz<SnapshotRow>(path), opts);
}

export function loadHtf(
  dir: string,
  symbol: string,
  interval: string,
  opts: LoadOptions = {}
): LoadResult<HtfRow> {
  const path = join(dir, 'htf', symbol, `${interval}.jsonl.gz`);
  return applyLockbox(readJsonlGz<HtfRow>(path), opts);
}
