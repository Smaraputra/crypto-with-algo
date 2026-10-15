/**
 * What has been measured about the v8 single-asset composite scorer
 * (configVersion 8). The label is shown wherever a v8 call or plan is shown.
 * It records the four verdicts below and nothing beyond them.
 */
export interface V8Study {
  name: string;
  date: string;
  verdict: string;
}

export const V8_STATUS = {
  label: 'Measured: no edge',
  asOf: '2026-10-14',
  summary:
    'v8 calls have been measured four ways and none beats chance after costs. They are kept as a record, not as advice.',
  studies: [
    {
      name: 'Live record',
      date: '2026-10-10',
      verdict:
        'Stored calls were right no more often than chance (balanced hit 0.43 to 0.48), and 1m calls lost about 0.19% each after costs.',
    },
    {
      name: 'Year re-score',
      date: '2026-10-10',
      verdict: 'Re-scored over a year, calls were right 44 to 47% of the time on a balanced basis, below chance.',
    },
    {
      name: 'Paper desk read',
      date: '2026-10-10',
      verdict: 'The 5m paper desk lost about 0.17% per trade.',
    },
    {
      name: 'Direction and exit study',
      date: '2026-10-11',
      verdict: 'None of the 24 pre-registered direction and exit configurations passed the confirm run.',
    },
  ] as V8Study[],
} as const;
