/**
 * The research trial ledger: the one authoritative count of trials (configurations
 * evaluated on data) across the whole program.
 *
 * Why it matters: multiple-testing corrections (Bonferroni families, the deflated
 * Sharpe trial count, alpha spending across rounds) all need this number. Before this
 * file it lived in prose in several places that drifted apart.
 *
 * The count before 2026-10-18 is carried as one baseline entry taken from the lab-v1
 * lock (`LAB_FORWARD_V1_LOCK.ledgerAfter`), which is the last count the program
 * recorded under review. Each later study appends ONE entry when its lock is committed,
 * with the number of trials it declares, and its RESULT block cites the running total.
 */

export interface LedgerEntry {
  /** Short study id, unique, e.g. 'baseline-2026-10-18', 'next-version-r1'. */
  id: string;
  /** ISO date the lock (or baseline) was recorded, 'YYYY-MM-DD'. */
  date: string;
  /** Trials this entry adds. The baseline carries the whole prior count. */
  trials: number;
  /** Where the trials are declared (file and constant or line). */
  source: string;
}

export const LEDGER: readonly LedgerEntry[] = [
  {
    id: 'baseline-2026-10-18',
    date: '2026-10-18',
    trials: 2169,
    source: 'scripts/research/lab-forward-v1.ts LAB_FORWARD_V1_LOCK.ledgerAfter (all trials through lab-v1)',
  },
  {
    id: 'next-version-r1',
    date: '2026-10-18',
    trials: 20,
    source: 'scripts/research/next-version-v1.ts NV1_LOCK (C1 4, C2 12, C3 4)',
  },
  {
    id: 'next-version-r2',
    date: '2026-10-20',
    trials: 10,
    source:
      'scripts/research/nv2-preview.ts SIGNALS x HOLDS (5 x 2), run on the VPS 2026-10-20 at 55ded39; lab-v3 F1-1d is the fund7 h7 cell and adds none',
  },
  {
    id: 'round3-lab-v4-preview',
    date: '2026-10-22',
    trials: 5,
    source:
      'scripts/research/lab-v4-preview.ts CANDIDATES C1, C2, C7 run 2026-10-22 at 05d427f, plus the C1 and C2 run of 2026-10-21 at a0474ae; nothing registered',
  },
];

/** Sum of trials over the ledger, or over the entries up to and including `throughId`. */
export function ledgerTotal(throughId?: string): number {
  if (throughId === undefined) {
    return LEDGER.reduce((sum, entry) => sum + entry.trials, 0);
  }

  const targetIndex = LEDGER.findIndex((entry) => entry.id === throughId);
  if (targetIndex === -1) {
    throw new Error(`unknown ledger entry: ${throughId}`);
  }

  let total = 0;
  for (let i = 0; i <= targetIndex; i++) {
    total += LEDGER[i].trials;
  }
  return total;
}
