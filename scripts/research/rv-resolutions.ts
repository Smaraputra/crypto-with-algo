/**
 * Funding resolutions for the rv-v1 panel (AMENDMENT 1 in scripts/research/rv-revalidation.ts).
 *
 * The panel flags settlements the coverage check expects but the export lacks, and the instants next to
 * every interval switch derived from null-interval spacing (rv-panel.ts fundingFlags). A flag is cleared
 * only by a recorded `no-event` entry: Binance's REST funding history for that symbol has no settlement
 * at that instant, with the REST settlement times either side recorded. This module drafts such entries
 * from REST, re-verifies a recorded file against REST at the `inputs` stage, and reads and writes the
 * file. The REST fetcher is injected (fetchFundingHistory in src/lib/snapshot-backfill.ts in the runner,
 * a stand-in in tests), so nothing here touches the network on its own.
 */
import { createHash } from 'crypto';
import { z } from 'zod';

import { settlementTimeOf } from '@/lib/funding-settlements';
import type { FundingFlag, FundingResolutions, ResolutionEntry } from './rv-panel';

/** How far either side of a flag REST is asked for settlements. Binance intervals are at most 8h. */
export const REST_NEIGHBOUR_WINDOW_MS = 24 * 3_600_000;

declare const verifiedBrand: unique symbol;

/**
 * A resolutions file that passed the REST re-check in this run (AMENDMENT 3). Only verifyResolutions makes
 * one: it is frozen, and a module-private registry lets assertVerified refuse a look-alike made by a cast
 * or a copy. The panel accepts nothing else.
 */
export interface VerifiedResolutions {
  readonly sha256: string;
  readonly entries: readonly ResolutionEntry[];
  readonly [verifiedBrand]: true;
}

const VERIFIED = new WeakSet<object>();

/** HALT unless `value` is the very object verifyResolutions returned. */
export function assertVerified(value: VerifiedResolutions): void {
  if (typeof value !== 'object' || value === null || !VERIFIED.has(value)) {
    throw new Error('HALT: the resolutions were not verified against REST in this run (AMENDMENT 3): pass the value verifyResolutions returns');
  }
}

/** Signature-compatible with fetchFundingHistory(symbol, startTime, endTime) in src/lib/snapshot-backfill.ts. */
export type FundingFetcher = (symbol: string, startTime: number, endTime: number) => Promise<ReadonlyArray<{ fundingTime: number }>>;

const iso = (t: number) => new Date(t).toISOString();

interface RestRead {
  at: boolean;
  before: number | null;
  after: number | null;
}

/** REST settlement times around `t`, each read to its settlement boundary (REST stamps old rows a few ms late). */
async function readRest(symbol: string, t: number, fetchFunding: FundingFetcher): Promise<RestRead> {
  const events = await fetchFunding(symbol, t - REST_NEIGHBOUR_WINDOW_MS, t + REST_NEIGHBOUR_WINDOW_MS);
  const times = [...new Set(events.map((e) => settlementTimeOf(e.fundingTime)))].sort((a, b) => a - b);
  const before = times.filter((x) => x < t);
  const after = times.filter((x) => x > t);
  return {
    at: times.includes(t),
    before: before.length > 0 ? before[before.length - 1] : null,
    after: after.length > 0 ? after[0] : null,
  };
}

/**
 * Proposes a `no-event` entry for each flag where REST has no settlement at the instant and has one on
 * each side within REST_NEIGHBOUR_WINDOW_MS. Every other flag stays unresolved with the reason, so the
 * panel halts on it: REST showing a settlement, a failed fetch, or a missing neighbour is never decided
 * here. The draft is evidence for the user to record, not a ruling.
 */
export async function draftResolutions(
  flags: readonly FundingFlag[],
  fetchFunding: FundingFetcher
): Promise<{ entries: ResolutionEntry[]; unresolved: { flag: FundingFlag; reason: string }[] }> {
  const entries: ResolutionEntry[] = [];
  const unresolved: { flag: FundingFlag; reason: string }[] = [];
  for (const flag of flags) {
    let rest: RestRead;
    try {
      rest = await readRest(flag.symbol, flag.t, fetchFunding);
    } catch (err) {
      unresolved.push({ flag, reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (rest.at) unresolved.push({ flag, reason: `REST shows a settlement at ${iso(flag.t)}` });
    else if (rest.before === null) unresolved.push({ flag, reason: `no REST settlement before ${iso(flag.t)} within the window` });
    else if (rest.after === null) unresolved.push({ flag, reason: `no REST settlement after ${iso(flag.t)} within the window` });
    else entries.push({ symbol: flag.symbol, t: flag.t, verdict: 'no-event', restBefore: rest.before, restAfter: rest.after });
  }
  return { entries, unresolved };
}

/**
 * The `inputs` stage re-check of a recorded file (AMENDMENT 1): re-queries REST for every entry and halts
 * on a verdict other than `no-event`, if REST cannot be reached, if REST shows a settlement at the
 * instant, or if the REST settlement times either side differ from the recorded ones. Returns the only
 * value the panel accepts (AMENDMENT 3). The panel then also requires the recorded neighbours to be the
 * export's own settlements either side.
 */
export async function verifyResolutions(resolutions: FundingResolutions, fetchFunding: FundingFetcher): Promise<VerifiedResolutions> {
  for (const e of resolutions.entries) {
    const label = `${e.symbol} ${iso(e.t)}`;
    if (e.verdict !== 'no-event') throw new Error(`HALT: resolution entry ${label} has verdict "${e.verdict}", only "no-event" is accepted`);
    let rest: RestRead;
    try {
      rest = await readRest(e.symbol, e.t, fetchFunding);
    } catch (err) {
      throw new Error(`HALT: REST cannot be reached to verify ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (rest.at) throw new Error(`HALT: REST shows a settlement at ${label}, so the no-event entry is wrong`);
    if (rest.before !== e.restBefore || rest.after !== e.restAfter) {
      throw new Error(
        `HALT: the REST neighbours of ${label} are ${rest.before === null ? 'none' : iso(rest.before)} and ${rest.after === null ? 'none' : iso(rest.after)}, recorded ${iso(e.restBefore)} and ${iso(e.restAfter)}`
      );
    }
  }
  const out = Object.freeze({
    sha256: resolutions.sha256,
    entries: Object.freeze(resolutions.entries.map((e) => Object.freeze({ ...e }))),
  }) as VerifiedResolutions;
  VERIFIED.add(out);
  return out;
}

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString() === s, {
  message: 'must be a canonical ISO instant (YYYY-MM-DDTHH:mm:ss.sssZ)',
});
const FileSchema = z.object({
  resolutions: z.array(
    z.object({ symbol: z.string().min(1), t: isoInstant, verdict: z.string(), restBefore: isoInstant, restAfter: isoInstant })
  ),
});

/** The recorded file text for a set of entries: ISO instants, one entry per flag, two-space JSON. */
export function serializeResolutions(entries: readonly ResolutionEntry[]): string {
  return `${JSON.stringify(
    {
      resolutions: entries.map((e) => ({ symbol: e.symbol, t: iso(e.t), verdict: e.verdict, restBefore: iso(e.restBefore), restAfter: iso(e.restAfter) })),
    },
    null,
    2
  )}\n`;
}

/** Reads a recorded file: the sha256 of the text as read and its entries. A malformed file throws. */
export function parseResolutions(text: string): FundingResolutions {
  const parsed = FileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`The resolutions file is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    entries: parsed.data.resolutions.map((r) => ({
      symbol: r.symbol,
      t: Date.parse(r.t),
      verdict: r.verdict,
      restBefore: Date.parse(r.restBefore),
      restAfter: Date.parse(r.restAfter),
    })),
  };
}
