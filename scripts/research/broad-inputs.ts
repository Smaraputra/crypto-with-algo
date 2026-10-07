/**
 * The broad trend phase's simulator inputs (broad-trend.ts header, DATA, CONTRACTS,
 * UNIVERSE and C3 BASKET): one TrendSymbolInput per CONTRACT, keyed by its contract
 * id, from a hash-verified export and a universe file built from that export.
 *
 *   - The export's manifest is verified (every file's sha256 and the dataset hash),
 *     the universe file's own sha256 recomputes (broad-trend.ts stableStringify, as
 *     universeFile writes it) and its sourceDatasetHash is the export's. Otherwise
 *     nothing is read.
 *   - Each needed contract (ever a universe or a C3 basket member) is re-segmented
 *     from the export's 1d perp klines (lockbox applied) and must match the universe
 *     file's metadata for it.
 *   - Its calendar runs from its first to its last traded bar; a missing or
 *     zero-volume day inside it is a CARRIED day (open = close = the last real close).
 *   - Funding: the archive's settlements within the contract's life. Every settlement
 *     due on a member day per the archive's own interval must exist: a missing one
 *     stops here, before any return is computed, naming the contract and the time.
 *
 * Computes no return, signal or statistic. The choices the header leaves open are
 * recorded in broad-trend.ts's implementation notes (A5).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { settlementSpacingReport } from '@/lib/funding-settlements';
import {
  BASKET_OPTIONS,
  DAY_MS,
  GAP_JUMP_RATIO,
  MAX_GAP_DAYS,
  MIN_RANKING_BARS,
  RANKING_WINDOW_DAYS,
  SAMPLE_END_MS,
  UNIVERSE_OPTIONS,
  contractEnded,
  contractMeta,
  dayStartMs,
  isoDay,
  segmentContracts,
  stableStringify,
  type Contract,
  type Membership,
  type UniverseFile,
} from './broad-trend';
import { LOCKBOX_START, type FundingRow, type PerpCandleRow } from './dataset-format';
import { loadFunding, loadManifest, loadPerp, verifyManifest } from './load-dataset';
import { assertBroadInput, type MembershipSpan, type Settlement, type TrendSymbolInput } from './trend-sim';

/** The BTC benchmark (gate 3, reported) holds BTCUSDT through the whole sample, so its funding is checked on every sample day. */
export const BENCHMARK_SYMBOL = 'BTCUSDT';

export interface BroadContract {
  id: string;
  symbol: string;
  assetKey: string;
  /** UTC year of the first bar: the gate 5 listing-year cohort. */
  listingYear: number;
  firstDay: number;
  lastDay: number;
  /** The last traded day when it ends before 2026-06-30 (a delisting), else null. */
  endDay: number | null;
  /** Traded bars. */
  bars: number;
  carriedDays: number;
  universe: boolean;
  basket: boolean;
}

export interface FundingSummary {
  /** Contracts whose settlements were read (universe members). */
  contracts: number;
  settlements: number;
  /** Changes of the stated interval between consecutive settlements. */
  intervalSwitches: number;
  /** Settlements per stated interval in hours ('null' when not stated). */
  byInterval: Record<string, number>;
}

export interface BroadInputs {
  datasetHash: string;
  universe: UniverseFile;
  /** The universe's start close (the sample start) and its exclusive end, UTC day starts. */
  from: number;
  to: number;
  /** Every needed contract, by id. */
  contracts: BroadContract[];
  /** Universe members: the sleeves, sorted by id; `symbol` is the contract id. */
  inputs: TrendSymbolInput[];
  /** C3 basket members, sorted by id (the same objects where a contract is both). */
  basketInputs: TrendSymbolInput[];
  /** Basket membership by contract id: member for days from <= d < to. */
  basketMembership: Record<string, Array<{ from: number; to: number }>>;
  funding: FundingSummary;
  lockboxApplied: boolean;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Header UNIVERSE: each contract's spans, ranking close to the next close (or the sample end), ranked at the close. */
export function universeSpans(membership: Membership): Record<string, MembershipSpan[]> {
  const out: Record<string, MembershipSpan[]> = {};
  for (const month of membership.months) {
    const from = dayStartMs(month.close);
    if (month.closeMs !== from) throw new Error(`Universe month ${month.close} carries closeMs ${month.closeMs}`);
    const to = dayStartMs(month.validUntil);
    for (const member of month.members) (out[member.id] ??= []).push({ from, to, rank: member.rank });
  }
  return out;
}

/** Header C3 BASKET: each basket member's days, close to the next close (or the sample end). */
export function basketSpans(membership: Membership): Record<string, Array<{ from: number; to: number }>> {
  const out: Record<string, Array<{ from: number; to: number }>> = {};
  for (const [id, spans] of Object.entries(universeSpans(membership))) out[id] = spans.map(({ from, to }) => ({ from, to }));
  return out;
}

/**
 * Header CONTRACTS: a contract's consecutive daily calendar from its first to its
 * last traded bar. A day without a traded bar inside it is carried: open = close =
 * the last real close, flagged 1.
 */
export function contractCalendar(contract: Contract): {
  t: number[];
  open: number[];
  close: number[];
  carried: Uint8Array;
  carriedDays: number;
} {
  const t: number[] = [];
  const open: number[] = [];
  const close: number[] = [];
  const flags: number[] = [];
  for (const bar of contract.bars) {
    while (t.length > 0 && bar.t - t[t.length - 1] > DAY_MS) {
      const last = close[close.length - 1];
      t.push(t[t.length - 1] + DAY_MS);
      open.push(last);
      close.push(last);
      flags.push(1);
    }
    t.push(bar.t);
    open.push(bar.o);
    close.push(bar.c);
    flags.push(0);
  }
  const carried = Uint8Array.from(flags);
  return { t, open, close, carried, carriedDays: flags.reduce((s, f) => s + f, 0) };
}

/** The parameters universeFile writes for the pre-registered universe. */
export function preregisteredParameters(): UniverseFile['parameters'] {
  return {
    universe: UNIVERSE_OPTIONS,
    basket: BASKET_OPTIONS,
    sampleEnd: isoDay(SAMPLE_END_MS),
    rankingWindowDays: RANKING_WINDOW_DAYS,
    minRankingBars: MIN_RANKING_BARS,
    maxGapDays: MAX_GAP_DAYS,
    gapJumpRatio: GAP_JUMP_RATIO,
  };
}

/**
 * Refuses a universe file whose sha256 does not recompute, whose source is not
 * this export, or (when `preregistered`) whose parameters are not the header's.
 */
export function verifyUniverseFile(json: unknown, datasetHash: string, opts: { preregistered: boolean }): UniverseFile {
  if (json === null || typeof json !== 'object') throw new Error('The universe file is not a JSON object');
  const file = json as UniverseFile;
  if (typeof file.sha256 !== 'string' || typeof file.sourceDatasetHash !== 'string') {
    throw new Error('The universe file carries no sha256 or sourceDatasetHash');
  }
  if (!file.universe || !Array.isArray(file.universe.months) || !file.basket || !Array.isArray(file.basket.months) || !Array.isArray(file.contracts)) {
    throw new Error('The universe file is missing its memberships or contracts');
  }
  const { sha256, ...content } = file;
  const recomputed = createHash('sha256').update(stableStringify(content)).digest('hex');
  if (recomputed !== sha256) throw new Error(`The universe file's sha256 does not recompute (${recomputed} against ${sha256})`);
  if (file.sourceDatasetHash !== datasetHash) {
    throw new Error(`The universe file was built from export ${file.sourceDatasetHash}, not ${datasetHash}`);
  }
  if (opts.preregistered && stableStringify(file.parameters) !== stableStringify(preregisteredParameters())) {
    throw new Error('The universe file\'s parameters are not the pre-registered ones');
  }
  if (file.universe.startClose === null) throw new Error('The universe never reaches its start threshold: there is no sample');
  return file;
}

export interface MissingSettlement {
  contract: string;
  t: number;
  reason: 'missing' | 'interval-unknown' | 'no-settlements';
}

/** The day a settlement at t is charged on: settlements in (d, d + 1 day] belong to day d. */
export function dueDay(t: number): number {
  return Math.floor((t - 1) / DAY_MS) * DAY_MS;
}

/**
 * Header DATA (funding): the settlements due on `checkDays` per the archive's own
 * interval that the archive lacks. `rows` are the contract's settlements within its
 * life (t in (firstDay, lastDay + 1 day]), sorted. Each row's interval is its
 * spacing to the next (settlementSpacingReport's convention): a longer gap is
 * missing settlements at that spacing; before the first row and after the last the
 * grid extends at their intervals. Not due: settlements up to 2026-07-01 00:00 and
 * after it (the lockbox), on the contract's first day before its first settlement
 * (it lists inside the day), and on a delisted contract's last day after its last
 * settlement (it stops inside the day). A row without a stated interval whose
 * stretch touches a check day cannot be verified and is reported as such.
 */
export function missingSettlements(
  contract: { id: string; firstDay: number; lastDay: number; endDay: number | null },
  rows: readonly FundingRow[],
  checkDays: ReadonlySet<number>,
  lockboxStart: number = LOCKBOX_START
): MissingSettlement[] {
  const out: MissingSettlement[] = [];
  if (checkDays.size === 0) return out;
  const due = (t: number) => checkDays.has(dueDay(t));
  const touches = (a: number, b: number) => {
    for (let d = Math.floor(a / DAY_MS) * DAY_MS; d <= b; d += DAY_MS) if (checkDays.has(d)) return true;
    return false;
  };
  const hours = (h: number) => h * 3_600_000;
  const lifeEnd = Math.min(contract.lastDay + DAY_MS, lockboxStart - 1);
  if (rows.length === 0) {
    out.push({ contract: contract.id, t: contract.firstDay, reason: 'no-settlements' });
    return out;
  }
  const first = rows[0];
  if (first.intervalHours === null) {
    if (touches(contract.firstDay, first.t)) out.push({ contract: contract.id, t: first.t, reason: 'interval-unknown' });
  } else {
    for (let t = first.t - hours(first.intervalHours); t > contract.firstDay + DAY_MS; t -= hours(first.intervalHours)) {
      if (due(t)) out.push({ contract: contract.id, t, reason: 'missing' });
    }
  }
  for (let i = 0; i + 1 < rows.length; i++) {
    const h = rows[i].intervalHours;
    if (h === null) {
      if (touches(rows[i].t, rows[i + 1].t)) out.push({ contract: contract.id, t: rows[i].t, reason: 'interval-unknown' });
      continue;
    }
    for (let t = rows[i].t + hours(h); t < rows[i + 1].t; t += hours(h)) if (due(t)) out.push({ contract: contract.id, t, reason: 'missing' });
  }
  const last = rows[rows.length - 1];
  if (last.intervalHours === null) {
    if (touches(last.t, lifeEnd)) out.push({ contract: contract.id, t: last.t, reason: 'interval-unknown' });
  } else {
    for (let t = last.t + hours(last.intervalHours); t <= lifeEnd; t += hours(last.intervalHours)) {
      if (contract.endDay !== null && dueDay(t) === contract.lastDay) continue;
      if (due(t)) out.push({ contract: contract.id, t, reason: 'missing' });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The days a contract's funding must be complete on: its member days in
 * [from, to) with a real (non-carried) bar, plus the day each membership ends while
 * it trades (a leaving sleeve under the one-bar delay holds through it). With
 * `wholeSample` (the BTC benchmark), every real day of [from, to).
 */
export function fundingCheckDays(
  input: TrendSymbolInput,
  from: number,
  to: number,
  wholeSample = false
): Set<number> {
  const days = new Set<number>();
  const real = (d: number) => {
    if (input.t.length === 0) return false;
    const i = Math.round((d - input.t[0]) / DAY_MS);
    return i >= 0 && i < input.t.length && input.t[i] === d && !(input.carried && input.carried[i] === 1);
  };
  if (wholeSample) {
    for (let d = from; d < to; d += DAY_MS) if (real(d)) days.add(d);
    return days;
  }
  const spans = input.membership ?? [];
  for (const span of spans) {
    for (let d = Math.max(span.from, from); d < Math.min(span.to, to); d += DAY_MS) if (real(d)) days.add(d);
    const continues = spans.some((s) => s.from === span.to);
    if (!continues && span.to < to && real(span.to)) days.add(span.to);
  }
  return days;
}

export interface BuildSource {
  datasetHash: string;
  universe: UniverseFile;
  perp: (symbol: string) => { rows: PerpCandleRow[]; lockboxApplied: boolean };
  funding: (symbol: string) => { rows: FundingRow[]; lockboxApplied: boolean };
}

function formatMissing(missing: readonly MissingSettlement[], symbolOf: (id: string) => string): string {
  const shown = missing
    .slice(0, 40)
    .map((m) => `${symbolOf(m.contract)} (${m.contract}) ${new Date(m.t).toISOString()} ${m.reason}`)
    .join('; ');
  return `${missing.length} funding settlement(s) due on member days are missing or unverifiable, and the header stops the run before any return is computed: ${shown}${missing.length > 40 ? '; ...' : ''}`;
}

/** The pure core of loadBroadInputs over in-memory sources (verifyUniverseFile is the caller's). */
export function buildBroadInputs(src: BuildSource): BroadInputs {
  const { universe } = src;
  const from = dayStartMs(universe.universe.startClose!);
  const to = dayStartMs(universe.universe.options.to);
  if (to > LOCKBOX_START) throw new Error(`The universe runs to ${universe.universe.options.to}, into the lockbox`);
  const uSpans = universeSpans(universe.universe);
  const bMembership = basketSpans(universe.basket);
  const needed = [...new Set([...Object.keys(uSpans), ...Object.keys(bMembership)])].sort();
  const metaById = new Map(universe.contracts.map((c) => [c.id, c]));
  const symbols = new Set<string>();
  for (const id of needed) {
    const meta = metaById.get(id);
    if (!meta) throw new Error(`The universe file lists member ${id} without its contract metadata`);
    symbols.add(meta.symbol);
  }

  let lockboxApplied = true;
  const segmented = new Map<string, Contract>();
  for (const symbol of [...symbols].sort()) {
    const perp = src.perp(symbol);
    lockboxApplied = lockboxApplied && perp.lockboxApplied;
    for (const contract of segmentContracts(symbol, perp.rows)) segmented.set(contract.id, contract);
  }

  const contracts: BroadContract[] = [];
  const inputs: TrendSymbolInput[] = [];
  const basketInputs: TrendSymbolInput[] = [];
  const fundingRows = new Map<string, FundingRow[]>();
  const missing: MissingSettlement[] = [];
  const summary: FundingSummary = { contracts: 0, settlements: 0, intervalSwitches: 0, byInterval: {} };
  for (const id of needed) {
    const contract = segmented.get(id);
    const meta = metaById.get(id)!;
    if (!contract) throw new Error(`Contract ${id} is in the universe file but not in the export`);
    if (stableStringify(contractMeta(contract)) !== stableStringify(meta)) {
      throw new Error(`Contract ${id} in the export differs from the universe file's metadata`);
    }
    const calendar = contractCalendar(contract);
    const firstDay = calendar.t[0];
    const lastDay = calendar.t[calendar.t.length - 1];
    const endDay = contractEnded(contract);
    const input: TrendSymbolInput = {
      symbol: id,
      t: calendar.t,
      open: calendar.open,
      close: calendar.close,
      listingDay: firstDay,
      settlements: [],
      carried: calendar.carried,
      membership: uSpans[id] ?? [],
      endDay,
    };
    const isMember = uSpans[id] !== undefined;
    if (isMember) {
      let rows = fundingRows.get(contract.symbol);
      if (!rows) {
        const loaded = src.funding(contract.symbol);
        lockboxApplied = lockboxApplied && loaded.lockboxApplied;
        rows = loaded.rows.filter((r) => Number.isFinite(r.rate) && Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
        fundingRows.set(contract.symbol, rows);
      }
      const life = rows.filter((r) => r.t > firstDay && r.t <= lastDay + DAY_MS);
      input.settlements = life.map((r): Settlement => ({ t: r.t, rate: r.rate }));
      const wholeSample = contract.symbol === BENCHMARK_SYMBOL;
      missing.push(
        ...missingSettlements({ id, firstDay, lastDay, endDay }, life, fundingCheckDays(input, from, to, wholeSample))
      );
      summary.contracts++;
      for (const year of settlementSpacingReport(life)) {
        summary.settlements += year.settlements;
        summary.intervalSwitches += year.intervalSwitches;
        for (const [h, n] of Object.entries(year.byInterval)) summary.byInterval[h] = (summary.byInterval[h] ?? 0) + n;
      }
    }
    assertBroadInput(input);
    if (isMember) inputs.push(input);
    if (bMembership[id] !== undefined) basketInputs.push(input);
    contracts.push({
      id,
      symbol: contract.symbol,
      assetKey: contract.assetKey,
      listingYear: new Date(firstDay).getUTCFullYear(),
      firstDay,
      lastDay,
      endDay,
      bars: contract.bars.length,
      carriedDays: calendar.carriedDays,
      universe: isMember,
      basket: bMembership[id] !== undefined,
    });
  }
  if (missing.length > 0) {
    const symbolOf = (id: string) => metaById.get(id)?.symbol ?? id;
    throw new Error(formatMissing(missing, symbolOf));
  }
  return {
    datasetHash: src.datasetHash,
    universe,
    from,
    to,
    contracts: contracts.sort(byId),
    inputs: inputs.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
    basketInputs: basketInputs.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
    basketMembership: bMembership,
    funding: summary,
    lockboxApplied,
  };
}

/**
 * Verifies the export's manifest and the universe file against it, then builds the
 * inputs from the export's 1d perp klines and funding settlements (lockbox applied).
 */
export async function loadBroadInputs(
  datasetDir: string,
  universePath: string,
  opts: { preregistered?: boolean } = {}
): Promise<BroadInputs> {
  const check = await verifyManifest(datasetDir);
  if (!check.ok) throw new Error(`Manifest verification failed: ${check.mismatches.join(', ')}`);
  const manifest = loadManifest(datasetDir);
  const universe = verifyUniverseFile(JSON.parse(readFileSync(universePath, 'utf8')), manifest.datasetHash, {
    preregistered: opts.preregistered ?? true,
  });
  return buildBroadInputs({
    datasetHash: manifest.datasetHash,
    universe,
    perp: (symbol) => loadPerp(datasetDir, symbol, '1d'),
    funding: (symbol) => loadFunding(datasetDir, symbol),
  });
}
