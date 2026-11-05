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
  {
    id: 'scalp-s1-r',
    date: '2026-10-29',
    trials: 12,
    source: 'scripts/research/py/scalp/lock.py CONFIG_IDS (3 rules x 2 holds x 2 executions) on span R',
  },
  {
    id: 'round4-controls',
    date: '2026-10-29',
    trials: 52,
    source:
      'scripts/research/py/r4/calibration.py noise_final_set() 40, pc_family() 6 (P1, P2, 4 decoys), exit_block() 6; kind control, outside the alpha-bearing N and the round-close V (r4/method.py A1.9)',
  },
  {
    id: 'round4-retests',
    date: '2026-10-29',
    trials: 6,
    source:
      'scripts/research/py/r4/natives.py NATIVE_RULES, the Phase 4 native re-tests; alpha-bearing within the 12 re-test budget (r4/method.py A1.9)',
  },
  {
    id: 'round4-controls-c4',
    date: '2026-11-02',
    trials: 52,
    source:
      'the Phase 4 re-run at C4 (r4/method.py A4.3 and A4.4): 40 noise, 6 positive-control and 6 exit runs, counted as re-runs after a code fix under M; kind control, outside the alpha-bearing N and the round-close V',
  },
  {
    id: 'round4-retests-c4',
    date: '2026-11-02',
    trials: 6,
    source:
      'the six native re-tests at C4 (r4/method.py A4.3 and A4.4); the re-test family reaches its cap of 12 and no re-test slot remains',
  },
  {
    id: 'round4-family-a',
    date: '2026-11-04',
    trials: 45,
    source:
      'scripts/research/py/r4/family_a.py family_a(), the 45 declared Phase 5 family A configurations (alpha-bearing, cap 48 with 3 reserved for refit twins and re-runs, .superpowers/sdd/round4/family-a-draft.md draft 3)',
  },
  {
    id: 'round4-family-c',
    date: '2026-11-04',
    trials: 9,
    source:
      'scripts/research/py/r4/family_c.py family_c(), the 9 declared Phase 5 family C volatility forecasts (counted separately from the 120 alpha-bearing trials, cap 12 with 3 reserved, .superpowers/sdd/round4/family-c-draft.md draft 5, declared by the final reviewed code commit)',
  },
  {
    id: 'round4-family-c-twin',
    date: '2026-11-04',
    trials: 1,
    source:
      'scripts/research/py/r4/family_c.py family_c_twin("C_LHAR-X_1h"), the no-refit twin of the family C finalist, run on D at c8f5849f in one of the 3 reserved slots (descriptive refit comparison, records/family_c_result_c8f5849f.json)',
  },
  {
    id: 'round4-family-d',
    date: '2026-11-05',
    trials: 9,
    source:
      'scripts/research/py/r4/family_d.py family_d(), the 9 declared Phase 5 family D configurations under Amendment 6 (A-lgbm score, inverse-volatility weights from the family C finalist, bands 0, 0.045 and 0.09 in cells C2, C4 and C5; alpha-bearing, cap 12 with 3 reserved, .superpowers/sdd/round4/family-d-draft.md draft 3)',
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
