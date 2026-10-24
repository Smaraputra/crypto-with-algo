export type ResearchStatus =
  | 'validated'
  | 'under-test'
  | 'rejected'
  | 'no-edge'
  | 'not-registered'
  | 'void'
  | 'descriptive';

export type ResearchFamily =
  | 'price-score'
  | 'relative-value'
  | 'research-program'
  | 'next-version'
  | 'forward-lab';

export interface SourceRef {
  /** Repo-relative path of a tracked file. */
  path: string;
  /** 1-based line where the figure's text appears. */
  line: number;
  /** The literal text in the source when it differs from the shown value (e.g. value '2,204', match '2204'). */
  match?: string;
}

export interface ResearchFigure {
  label: string;
  value: string;
  source: SourceRef;
}

export interface ResearchReference {
  label: string;
  /** Repo-relative path of a tracked file. */
  path?: string;
  pr?: number;
  /** YYYY-MM-DD */
  date?: string;
}

export interface ResearchEntry {
  id: string;
  name: string;
  family: ResearchFamily;
  status: ResearchStatus;
  /** e.g. 'Run 2026-10-08' or 'Live since 2026-10-18'. */
  period: string;
  /** One sentence: what was tested. */
  summary: string;
  /** The method in plain words, in order. */
  steps: string[];
  /** The verdict in plain words. */
  result: string;
  figures: ResearchFigure[];
  /** Caveats, what it fed into, what it replaced. */
  research: string[];
  references: ResearchReference[];
  /** Lab hypothesis ids (e.g. 'L1-8h') whose live state the page overlays. */
  labHypotheses?: string[];
  /** Coins the entry trades, for links to /focus. */
  symbols?: string[];
}

export const RESEARCH_FAMILIES: Record<ResearchFamily, { label: string; description: string }> = {
  'forward-lab': {
    label: 'Forward lab',
    description: 'Pre-registered live test tracking unspent future bars with betting martingales.',
  },
  'next-version': {
    label: 'Next version',
    description: 'Candidate screening and holdout tests on earlier historical data for next scorer versions.',
  },
  'relative-value': {
    label: 'Relative value',
    description: 'Cross-sectional relative ranking models trading long expected winners against short losers.',
  },
  'price-score': {
    label: 'Price score',
    description: 'Single-asset directional composite scores combining trend, momentum, volume, and volatility.',
  },
  'research-program': {
    label: 'Research program',
    description: 'Systematic research studies evaluating specific market factors, event windows, and trade families.',
  },
};

/** The trial ledger total the page shows; the test pins it to ledgerTotal(). */
export const LEDGER_TOTAL = 2204;

export const RESEARCH_CATALOG: readonly ResearchEntry[] = [
  // =========================================================================
  // forward-lab (newest first)
  // =========================================================================
  {
    id: 'lab-v4',
    name: 'Forward lab v4 (S1 and S2)',
    family: 'forward-lab',
    status: 'under-test',
    period: 'Live since 2026-10-22',
    summary: 'Two 1-hour trading rules registered by owner override after their preview failed, tracked forward on live bars.',
    steps: [
      'S1-1h trades swing market structure breaks (CHoCH, a break of the previous swing high or low) when the break bar taker delta has the same sign as the break.',
      'S2-1h fades regular delta divergences between the two most recent confirmed swing pivots at most 72 bars apart, confirmed on that last bar.',
      'Both rules enter at the open 10 minutes after bar close, hold for 8 hours, and pay 14 bps round trip fees plus funding.',
      'Judged by an e-process (a test martingale that can be stopped at any time without invalidating error rates) with a validation threshold of 800.',
    ],
    result: 'Under test since 2026-10-22, registered by owner override despite negative preview returns, and predicted to lose after trading costs.',
    figures: [
      {
        label: 'S1 preview net return per trade',
        value: '-0.126%',
        source: { path: 'scripts/research/lab-forward-v4.ts', line: 17 },
      },
      {
        label: 'S2 preview net return per trade',
        value: '-0.093%',
        source: { path: 'scripts/research/lab-forward-v4.ts', line: 18 },
      },
      {
        label: 'Validation threshold',
        value: '800',
        source: { path: 'scripts/research/lab-forward-v4.ts', line: 135 },
      },
      {
        label: 'Round trip cost rate',
        value: '0.0014',
        source: { path: 'scripts/research/lab-forward-v4.ts', line: 138 },
      },
    ],
    research: [
      'Registered by an explicit owner override following the Round 3 candidate preview in which all candidate rules lost after fees.',
      'The rules were renamed S1 and S2 so they are not confused with Round 1 rules C1 and C2.',
    ],
    references: [
      {
        label: 'lab-forward-v4 lock',
        path: 'scripts/research/lab-forward-v4.ts',
        pr: 112,
        date: '2026-10-22',
      },
    ],
    labHypotheses: ['S1-1h', 'S2-1h'],
    symbols: [
      'BTCUSDT',
      'ETHUSDT',
      'BNBUSDT',
      'SOLUSDT',
      'XRPUSDT',
      'ADAUSDT',
      'DOGEUSDT',
      'AVAXUSDT',
      'DOTUSDT',
      'LINKUSDT',
    ],
  },
  {
    id: 'lab-v3',
    name: 'Forward lab v3 (F1 carry)',
    family: 'forward-lab',
    status: 'under-test',
    period: 'Live since 2026-10-22',
    summary: 'Weekly staggered funding-rate carry across the top 30 perpetual contracts, tracked on live bars.',
    steps: [
      'At each daily close, calculate trailing 7-day net funding received for each of the top 30 Binance perpetual contracts.',
      'Construct a dollar-neutral, gross-1 target book taking long positions in low funding coins and short positions in high funding coins.',
      'Hold the portfolio as a seven-day staggered book, averaging daily target allocations across the past week.',
      'Judge net book returns using an e-process (a test martingale that can be stopped at any time without invalidating error rates) with threshold 200.',
    ],
    result: 'Under test since 2026-10-22, predicted not to cross threshold 200 within 24 months as net return stays near zero.',
    figures: [
      {
        label: 'Preview annual Sharpe ratio',
        value: '0.82',
        source: { path: 'scripts/research/lab-forward-v3.ts', line: 13 },
      },
      {
        label: 'Preview daily mean return',
        value: '+0.038%',
        source: { path: 'scripts/research/lab-forward-v3.ts', line: 20 },
      },
      {
        label: 'Validation threshold',
        value: '200',
        source: { path: 'scripts/research/lab-forward-v3.ts', line: 175 },
      },
      {
        label: 'Delisting haircut',
        value: '0.02',
        source: { path: 'scripts/research/lab-forward-v3.ts', line: 187 },
      },
    ],
    research: [
      'Selected from the Round 2 candidate preview as the top performer among ten tested funding and momentum configurations.',
      'Power simulations show a 2 to 3 percent chance of crossing within 24 months at the measured historical edge.',
    ],
    references: [
      {
        label: 'lab-forward-v3 lock',
        path: 'scripts/research/lab-forward-v3.ts',
        pr: 108,
        date: '2026-10-21',
      },
    ],
    labHypotheses: ['F1-1d'],
    symbols: [
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
      'ZECUSDT',
      'NEARUSDT',
      'XRPUSDT',
      'HYPEUSDT',
      'DOGEUSDT',
      'SUIUSDT',
      'BNBUSDT',
      'UNIUSDT',
      'ENAUSDT',
      'WLDUSDT',
      'PUMPUSDT',
      '1000PEPEUSDT',
      'ADAUSDT',
      'QNTUSDT',
      'AVAXUSDT',
      'LINKUSDT',
      'TAOUSDT',
      'FILUSDT',
      'ONDOUSDT',
      'AAVEUSDT',
      'ARBUSDT',
      'LTCUSDT',
      'TRUMPUSDT',
      'BCHUSDT',
      'INJUSDT',
      'STRKUSDT',
      'PENGUUSDT',
    ],
  },
  {
    id: 'lab-v2',
    name: 'Forward lab v2 (N2 and N3)',
    family: 'forward-lab',
    status: 'under-test',
    period: 'Live since 2026-10-19',
    summary: 'Two candidate screen survivors from Round 1 tracked on unread forward bars.',
    steps: [
      'N2-1w fits a weekly ridge regression on five spot features with trailing 260-week lookback, holding dollar-neutral books.',
      'N3-1d trades daily value area migrations derived from 15m spot candles over three days.',
      'Both rules enter 10 minutes after bar boundaries on perpetual contracts, accounting for funding and realistic fees.',
      'Evaluated by an e-process (a test martingale that can be stopped at any time without invalidating error rates) with threshold 400 per slot.',
    ],
    result: 'Under test since 2026-10-19, predicted that neither hypothesis crosses threshold 400 within 24 months.',
    figures: [
      {
        label: 'N2 preview mean return per week',
        value: '+0.072%',
        source: { path: 'scripts/research/lab-forward-v2.ts', line: 101 },
      },
      {
        label: 'N3 preview mean return per day',
        value: '+0.237%',
        source: { path: 'scripts/research/lab-forward-v2.ts', line: 102 },
      },
      {
        label: 'Validation threshold',
        value: '400',
        source: { path: 'scripts/research/lab-forward-v2.ts', line: 160 },
      },
      {
        label: 'N3 trade cost rate',
        value: '0.0014',
        source: { path: 'scripts/research/lab-forward-v2.ts', line: 167 },
      },
    ],
    research: [
      'Derived from Round 1 historical screen survivors, where N2 had a high null promotion rate of 0.615 and was marked weak.',
      'Allocated two of four lab-v2 slots at alpha 0.0025 each, with slot 1 remaining empty from C1 failure and slot 4 reserved.',
    ],
    references: [
      {
        label: 'lab-forward-v2 lock',
        path: 'scripts/research/lab-forward-v2.ts',
        pr: 105,
        date: '2026-10-18',
      },
    ],
    labHypotheses: ['N2-1w', 'N3-1d'],
    symbols: [
      'BTCUSDT',
      'ETHUSDT',
      'BNBUSDT',
      'SOLUSDT',
      'XRPUSDT',
      'ADAUSDT',
      'DOGEUSDT',
      'AVAXUSDT',
      'DOTUSDT',
      'LINKUSDT',
    ],
  },
  {
    id: 'lab-v1',
    name: 'Forward lab v1 (L1 to L4)',
    family: 'forward-lab',
    status: 'under-test',
    period: 'Live since 2026-10-18',
    summary: 'Eight pre-registered hypotheses across four frozen candidates judged on unspent forward bars.',
    steps: [
      'Candidate L1-8h uses relative value rank, L2 tests combined v8 score and relative value across five timeframes, L3-8h tests variance fade, and L4-8h tests positioning fade.',
      'Grades each bar by rank correlation (information coefficient, a rank correlation measuring how well scores predict future price moves) between candidate scores and future returns.',
      'Deducts a dynamic hurdle b_t reflecting portfolio turnover and recent return volatility.',
      'Runs an e-process (a test martingale that can be stopped at any time without invalidating error rates) with e-Bonferroni correction over K = 8 hypotheses at alpha 0.01 (threshold 800).',
    ],
    result: 'Under test since 2026-10-18, predicted that no hypothesis crosses 800 within 24 months.',
    figures: [
      {
        label: 'Significance alpha',
        value: '0.01',
        source: { path: 'scripts/research/lab-forward-v1.ts', line: 185 },
      },
      {
        label: 'Validation threshold',
        value: '800',
        source: { path: 'scripts/research/lab-forward-v1.ts', line: 186 },
      },
      {
        label: 'Taker cost per side',
        value: '0.0007',
        source: { path: 'scripts/research/lab-forward-v1.ts', line: 190 },
      },
      {
        label: 'Trial ledger after lock',
        value: '2,169',
        source: { path: 'scripts/research/lab-forward-v1.ts', line: 201, match: '2169' },
      },
    ],
    research: [
      'Established because all historical data through October 2026 had been read during earlier research phases, making fresh forward bars the only clean confirmation.',
      'Amendment 1 recorded deploy timing and Amendment 2 repaired 4h positioning ratio window assembly from stored historical points.',
    ],
    references: [
      {
        label: 'lab-forward-v1 lock',
        path: 'scripts/research/lab-forward-v1.ts',
        date: '2026-10-18',
      },
      {
        label: 'lab-v1 jobs (PR 98)',
        pr: 98,
        date: '2026-10-18',
      },
    ],
    labHypotheses: [
      'L1-8h',
      'L2-5m',
      'L2-15m',
      'L2-1h',
      'L2-4h',
      'L2-1d',
      'L3-8h',
      'L4-8h',
    ],
    symbols: [
      'BTCUSDT',
      'ETHUSDT',
      'BNBUSDT',
      'SOLUSDT',
      'XRPUSDT',
      'ADAUSDT',
      'DOGEUSDT',
      'AVAXUSDT',
      'DOTUSDT',
      'LINKUSDT',
    ],
  },

  // =========================================================================
  // next-version (newest first)
  // =========================================================================
  {
    id: 'next-version-round-3',
    name: 'Next version round 3 (C1, C2, and C7)',
    family: 'next-version',
    status: 'not-registered',
    period: 'Run 2026-10-22',
    summary: 'Pre-lock candidate preview testing three intraday setups under a pre-committed decision table.',
    steps: [
      'Evaluated C1 (hourly swing break with matching delta), C2 (hourly delta divergence fade), and C7 (open interest crowding with funding).',
      'Simulated 8-hour holds with 14 bps round trip fees and funding costs across 10 perpetual contracts from 2022 to June 2026.',
      'Applied a pre-registered decision table requiring positive mean return and minimum bootstrap crossing probability.',
    ],
    result: 'Nothing registered because every candidate produced negative net return after trading costs.',
    figures: [
      {
        label: 'C1 mean net return per trade',
        value: '-0.126%',
        source: { path: 'scripts/research/lab-v4-preview.ts', line: 37 },
      },
      {
        label: 'C2 mean net return per trade',
        value: '-0.093%',
        source: { path: 'scripts/research/lab-v4-preview.ts', line: 38 },
      },
      {
        label: 'C7 mean net return per trade',
        value: '-0.105%',
        source: { path: 'scripts/research/lab-v4-preview.ts', line: 39 },
      },
      {
        label: 'Round trip cost rate',
        value: '0.0014',
        source: { path: 'scripts/research/lab-v4-preview.ts', line: 73 },
      },
    ],
    research: [
      'All three rules proved cost-bound: gross returns were near zero while round trip fees consumed 14 bps per trade.',
      'Despite the formal rejection, the project owner later chose to register C1 and C2 as S1 and S2 in forward lab v4 as a forward record.',
    ],
    references: [
      {
        label: 'Round 3 candidate preview',
        path: 'scripts/research/lab-v4-preview.ts',
        date: '2026-10-22',
      },
    ],
  },
  {
    id: 'next-version-round-2',
    name: 'Next version round 2 (F1 carry preview)',
    family: 'next-version',
    status: 'descriptive',
    period: 'Run 2026-10-20',
    summary: 'Exploratory preview testing five candidate signals at 1-day and 7-day holding periods on 30 perpetual contracts.',
    steps: [
      'Evaluated five signals: fund7, fundChange, mom1, rev7, and lottery30 over 1,947 days (2021 to 2026).',
      'Simulated daily rank-weighted long-short books with liquidity-tiered slippage and delisting haircuts.',
      'Compared 1-day hold against 7-day staggered holding implementations.',
    ],
    result: 'fund7 with 7-day holding achieved the highest net annual Sharpe ratio of 0.82 and was selected to feed forward lab v3.',
    figures: [
      {
        label: 'Delisting haircut rate',
        value: '0.02',
        source: { path: 'scripts/research/nv2-preview.ts', line: 18 },
      },
      {
        label: 'Taker fee rate per side',
        value: '0.0005',
        source: { path: 'scripts/research/nv2-preview.ts', line: 19 },
      },
      {
        label: 'Minimum scored coins',
        value: '10',
        source: { path: 'scripts/research/nv2-preview.ts', line: 17 },
      },
    ],
    research: [
      'Status is descriptive because the study was an exploratory selection tool rather than a formal gated hypothesis test.',
      'Because fund7 was chosen as the best of ten variations on the full history, the 0.82 Sharpe ratio overstates future expected performance.',
    ],
    references: [
      {
        label: 'Round 2 candidate preview',
        path: 'scripts/research/nv2-preview.ts',
        date: '2026-10-20',
      },
    ],
  },
  {
    id: 'next-version-round-1',
    name: 'Next version round 1 (C1, C2, and C3)',
    family: 'next-version',
    status: 'rejected',
    period: 'Run 2026-10-18',
    summary: "Pre-registered candidate evaluation where rejection was C1's (gated, failed), while C2 and C3 only survived screens and went on to lab-v2.",
    steps: [
      'Tested C1 (price score with confirmation delay k) on unread historical holdout segment A (2017 to 2021).',
      'Screened C2 (weekly cross-sectional ridge regression on 5 spot features) across segments B and C.',
      'Screened C3 (daily value-area migration from 15m spot candles) across segments B and C.',
    ],
    result: 'Rejected because C1 failed its gated test on holdout segment A (p-value 0.125), meaning round 1 had no gated pass despite C2 and C3 screen survivals.',
    figures: [
      {
        label: 'C1 holdout test p-value',
        value: '0.125',
        source: { path: 'scripts/research/next-version-v1.ts', line: 98 },
      },
      {
        label: 'C1 max standardized score',
        value: '1.624',
        source: { path: 'scripts/research/next-version-v1.ts', line: 98 },
      },
      {
        label: 'C2 surviving cell weekly net return B',
        value: '+0.136%',
        source: { path: 'scripts/research/next-version-v1.ts', line: 119 },
      },
      {
        label: 'C3 k 1 surviving cell pooled net return',
        value: '+0.056% per one-day trade',
        source: { path: 'scripts/research/next-version-v1.ts', line: 129, match: '+0.056' },
      },
    ],
    research: [
      "C1's only clearly positive stretch was segment A1 (2017 to 2018, driven by 2017 +1.87). A2, B and C were flat or negative, so no delay gave a consistent edge.",
      'C2 and C3 advanced to forward lab v2 under strict forward-only alpha spending.',
    ],
    references: [
      {
        label: 'Next version round 1 lock',
        path: 'scripts/research/next-version-v1.ts',
        date: '2026-10-18',
      },
    ],
  },

  // =========================================================================
  // relative-value (newest first)
  // =========================================================================
  {
    id: 'rv-v1-revalidation',
    name: 'Relative value rv-v1 re-validation',
    family: 'relative-value',
    status: 'rejected',
    period: 'Run 2026-10-15',
    summary: "Pre-registered re-validation of frozen 8-hour relative value rule rv-v1 on perpetual prices using Masters' four-step procedure (two of the steps are permutation tests).",
    steps: [
      'Built an 8-hour panel of Binance perpetual bars (5,240 bars, 2022-01-01 to 2026-10-13) across 10 symbols, with funding settlements.',
      'G1: Step 2 in-sample permutation with M = 1,000 permutations re-selecting all 12 strategy cells.',
      'G2: Step 4 walk-forward permutation with M = 1,000 permutations across 15 rolling folds.',
      'G3: Deflated Sharpe ratio (a statistical test that discounts the best Sharpe ratio for how many variations were tested) test for rv-v1 at trial count N = 672.',
    ],
    result: 'Rejected because while permutation tests G1 and G2 passed, G3 failed with deflated Sharpe probability of 0.1034 against the 0.95 hurdle.',
    figures: [
      {
        label: 'G1 in-sample permutation p-value',
        value: '0.0020',
        source: { path: 'scripts/research/rv-revalidation.ts', line: 283 },
      },
      {
        label: 'G2 walk-forward permutation p-value',
        value: '0.0030',
        source: { path: 'scripts/research/rv-revalidation.ts', line: 284 },
      },
      {
        label: 'G3 deflated Sharpe probability',
        value: '0.1034',
        source: { path: 'scripts/research/rv-revalidation.ts', line: 285 },
      },
      {
        label: 'Net taker paper return, 2022-01-15 to 2026-10-13',
        value: '+130.2%',
        source: { path: 'scripts/research/rv-revalidation.ts', line: 294 },
      },
      {
        label: '2026 to 2026-10-13 net taker return',
        value: '-22.0%',
        source: { path: 'scripts/research/rv-revalidation.ts', line: 298 },
      },
    ],
    research: [
      "Passing G1 and G2 confirmed real time structure destroyed by bar shuffles, but G3 demonstrated the edge was too small to survive multiple testing at this phase's count (N = 672, with the program count reported only).",
      'By the failure action, the desk keeps recording rv-v1 as a descriptive forward test labelled not validated, and the docs record the failure.',
    ],
    references: [
      {
        label: 'rv-v1 pre-registered re-validation lock',
        path: 'scripts/research/rv-revalidation.ts',
        date: '2026-10-15',
      },
      {
        label: 'Technical documentation section 8.7',
        path: 'docs/TECHNICAL.md',
        date: '2026-10-15',
      },
    ],
  },
  {
    id: 'rv-8h-legacy-validation',
    name: 'First 8-hour relative value validation',
    family: 'relative-value',
    status: 'void',
    period: 'Conducted before 2026-10-14',
    summary: 'Initial validation of the 8-hour relative value model, later found completely void during technical audit.',
    steps: [
      'Evaluated an 8-hour cross-sectional ranking system combining momentum, idiosyncratic return, carry, and taker flow.',
      'Reported backtest returns and permutation test statistics supporting an active strategy claim.',
      'Audited on 2026-10-14 (recorded in the docs on 2026-10-15) across methodological and data integrity defects (docs/TECHNICAL.md near line 767).',
    ],
    result: 'Void because the audit proved it traded spot candles rather than perpetuals, assumed an arbitrary trial count, the walk-forward null was synthetic Gaussian noise (docs/TECHNICAL.md near line 793), the in-sample permutation used fixed parameters and did not permute funding (near line 792), and the 1,000-trial run omitted --allow-lockbox (near line 792).',
    figures: [
      {
        label: 'Void claimed p-value',
        value: '0.0199',
        source: { path: 'docs/TECHNICAL.md', line: 790 },
      },
      {
        label: 'Void claimed deflated Sharpe probability (net maker)',
        value: '0.8351 (void)',
        source: { path: 'docs/TECHNICAL.md', line: 785 },
      },
    ],
    research: [
      'The retracted table is kept for the record only and must not be cited as validation (docs/TECHNICAL.md section 8.5).',
      'The entire validation was retracted in technical documentation sections 8.5 and 8.6, prompting the pre-registered re-validation in rv-revalidation.ts.',
    ],
    references: [
      {
        label: 'Technical documentation sections 8.5 and 8.6',
        path: 'docs/TECHNICAL.md',
        date: '2026-10-15',
      },
    ],
  },

  // =========================================================================
  // price-score (newest first)
  // =========================================================================
  {
    id: 'v8-composite',
    name: 'v8 single-asset composite',
    family: 'price-score',
    status: 'no-edge',
    period: 'Measured 2026-10-10 to 2026-10-14',
    summary: 'Synthesis of four independent empirical studies evaluating the production v8 single-asset composite score.',
    steps: [
      'Live record study measuring balanced hit rates and net returns of stored production composite signals across 8.6 live days.',
      'Year re-score study running the v8 scorer on historical data across six timeframe cells over a full year.',
      'Paper desk forward simulation tracking realized trade performance after fees (the paper desk lost about 0.17% per trade).',
      'Direction and exit study evaluating 24 pre-registered rule and exit combinations.',
    ],
    result: 'Measured as having no edge, because none of the four studies beats chance after trading costs.',
    figures: [
      {
        label: 'Live record balanced hit rate range',
        value: '0.43 to 0.48',
        source: { path: 'src/lib/signals/v8-status.ts', line: 22 },
      },
      {
        label: 'Live record 1m net loss per trade',
        value: '0.19%',
        source: { path: 'src/lib/signals/v8-status.ts', line: 22 },
      },
      {
        label: 'Year re-score balanced hit rate range',
        value: '44 to 47%',
        source: { path: 'src/lib/signals/v8-status.ts', line: 27 },
      },
      {
        label: 'Paper desk 5m loss per trade',
        value: '0.17%',
        source: { path: 'src/lib/signals/v8-status.ts', line: 32 },
      },
      {
        label: 'Direction and exit tested configurations',
        value: '24',
        source: { path: 'src/lib/signals/v8-status.ts', line: 37 },
      },
    ],
    research: [
      'Officially designated as Measured: no edge across the user interface.',
      'Live signal calculation and paper desk tracking remain running as a benchmark record, but optimization schedules and 1m scoring were terminated.',
    ],
    references: [
      {
        label: 'v8 status specification',
        path: 'src/lib/signals/v8-status.ts',
        date: '2026-10-14',
      },
    ],
  },
  {
    id: 'price-score-direction-exit',
    name: 'Direction and exit study',
    family: 'price-score',
    status: 'no-edge',
    period: 'Run 2026-10-11',
    summary: 'Pre-registered test of 24 composite direction rules and exit variants on confirmation data.',
    steps: [
      'Tested three direction rules: D0 (control calls), D1 (sign-corrected equal weights), and D2 (abstention rules C1 to C4).',
      'Tested four exit rules: E1 (fixed horizon), E2 (take-profit at k ATR), E3 (target and stop), and E4 (score reversal).',
      'Evaluated all 24 configurations on confirmation period (2025 to October 2026) at 1h and 4h intervals.',
    ],
    result: 'No configuration passed because all 24 confirmation runs failed expectancy, consistency windows, symbol count, and deflated Sharpe ratio tests.',
    figures: [
      {
        label: '1h D0 E1 confirmation period net expectancy % (2025-01 to 2026-10-09)',
        value: '-0.165',
        source: { path: 'scripts/research/direction-exit.ts', line: 254 },
      },
      {
        label: '1h D0 E1 develop slice net expectancy % (it selects and is never judged)',
        value: '-0.025',
        source: { path: 'scripts/research/direction-exit.ts', line: 239 },
      },
      {
        label: 'Confirmation tested configurations',
        value: '24',
        source: { path: 'scripts/research/direction-exit.ts', line: 119 },
      },
    ],
    research: [
      'Showed that take-profit exits increased win rates but proportionally reduced average win size, producing no net improvement in expectancy.',
      'Showed (median favourable and adverse excursions and touch rates) the price paths of composite calls matched the paths of random entries, confirming there was no excursion an exit rule could harvest.',
    ],
    references: [
      {
        label: 'Direction and exit study lock',
        path: 'scripts/research/direction-exit.ts',
        date: '2026-10-11',
      },
    ],
  },
  {
    id: 'price-score-v8-rescore',
    name: 'v8 year re-score',
    family: 'price-score',
    status: 'no-edge',
    period: 'Run 2026-10-10',
    summary: 'Pre-registered re-scoring of historical closed bars over a full year using the v8 scoring algorithm.',
    steps: [
      'Re-scored 1,553,180 closed bars from October 2025 to October 2026 across ten symbols and six timeframe cells.',
      'Evaluated balanced hit rate, spread, and net directional returns after costs using live outcome resolver definitions.',
      'Calculated moving-block bootstrap confidence intervals at the Bonferroni-corrected 99.17% level.',
    ],
    result: 'No detectable edge in any cell, with calls at 5m, 15m, and 1h pointing the wrong way more often than chance.',
    figures: [
      {
        label: '5m balanced hit rate',
        value: '0.467',
        source: { path: 'scripts/research/v8-rescore.ts', line: 79 },
      },
      {
        label: '5m net return per signal %',
        value: '-0.203',
        source: { path: 'scripts/research/v8-rescore.ts', line: 79 },
      },
      {
        label: '15m balanced hit rate',
        value: '0.459',
        source: { path: 'scripts/research/v8-rescore.ts', line: 80 },
      },
      {
        label: '1h balanced hit rate',
        value: '0.441',
        source: { path: 'scripts/research/v8-rescore.ts', line: 81 },
      },
    ],
    research: [
      'Verified parity with live v8 production rows on tens of thousands of matched bars, showing news absence had negligible impact on scores.',
      'Confirmed the 8.6-day live record conclusion over a full year of data.',
    ],
    references: [
      {
        label: 'v8 year re-score study lock',
        path: 'scripts/research/v8-rescore.ts',
        date: '2026-10-10',
      },
    ],
  },
  {
    id: 'price-score-live-record',
    name: 'Live record evaluation',
    family: 'price-score',
    status: 'no-edge',
    period: 'Run 2026-10-10',
    summary: 'Evaluation of 280,942 stored live composite signal outcomes to test whether scheduler calls beat chance.',
    steps: [
      'Analyzed stored production signals and outcomes for versions 4, 7, and 8 across five style-interval cells.',
      'Calculated balanced hit rate, buy-sell spread, and net directional returns after taker fees and slippage.',
      'Performed moving-block bootstrap with 2,000 resamples at the 99% confidence level.',
    ],
    result: 'Version 8 live calls showed no detectable edge at 1m, 5m, 15m, and 1h, losing round-trip costs on large intraday samples.',
    figures: [
      {
        label: 'v8 1m balanced hit rate',
        value: '0.481',
        source: { path: 'scripts/research/live-record.ts', line: 104 },
      },
      {
        label: 'v8 1m net return per signal %',
        value: '-0.194',
        source: { path: 'scripts/research/live-record.ts', line: 104 },
      },
      {
        label: 'v8 5m balanced hit rate',
        value: '0.456',
        source: { path: 'scripts/research/live-record.ts', line: 105 },
      },
      {
        label: 'v8 5m paper desk expectancy %',
        value: '-0.171%',
        source: { path: 'scripts/research/live-record.ts', line: 131 },
      },
    ],
    research: [
      'Earlier version 7 signals went the wrong way significantly more often than chance during its single week in production.',
      'Prompted the year re-score.',
    ],
    references: [
      {
        label: 'Live record study lock',
        path: 'scripts/research/live-record.ts',
        date: '2026-10-10',
      },
    ],
  },
  {
    id: 'price-score-forward-track',
    name: 'Forward track record',
    family: 'price-score',
    status: 'descriptive',
    period: 'Run 2026-10-10',
    summary: 'Descriptive month-by-month review of three frozen forward-test rules over the preceding year.',
    steps: [
      'Examined 13 calendar months from October 2025 to October 2026, labelling each month as previously used or forward.',
      'Tracked rule A1 (5m RSI bottom 10% buy) and A2 (5m RSI top 10% sell) against a matched baseline.',
      'Tracked rule B (1h small-trade order imbalance) using pooled rank correlation (information coefficient, a rank correlation measuring how well scores predict future price moves) with forward returns.',
    ],
    result: 'Small-trade imbalance showed consistent negative correlation in 11 of 13 months, but stayed below breakeven costs. A1 and A2 were positive in most months (11 of 13 each), and the source says this does not sharpen the verdict.',
    figures: [
      {
        label: 'A1 year excess win rate points',
        value: '+1.53',
        source: { path: 'scripts/research/forward-track.ts', line: 61 },
      },
      {
        label: 'A2 year excess win rate points',
        value: '+1.19',
        source: { path: 'scripts/research/forward-track.ts', line: 61 },
      },
      {
        label: 'Rule B small-trade year pooled IC',
        value: '-0.0190',
        source: { path: 'scripts/research/forward-track.ts', line: 61 },
      },
    ],
    research: [
      'Carried out as a descriptive read without pass or fail claims and added no trials to the program ledger.',
      'Demonstrated that while small-trade imbalance was persistent, its magnitude was insufficient to clear 1h taker fees.',
    ],
    references: [
      {
        label: 'Forward track record lock',
        path: 'scripts/research/forward-track.ts',
        date: '2026-10-10',
      },
    ],
  },
  {
    id: 'price-score-composite-audit',
    name: 'Composite sign audit',
    family: 'price-score',
    status: 'no-edge',
    period: 'Run 2026-09-26',
    summary: 'Audit of live composite score components against measured predictive information coefficients.',
    steps: [
      'Mapped every live signal indicator and category to its empirical information coefficient (IC, a rank correlation measuring how well scores predict future price moves) from factor studies.',
      'Computed the net weighted contribution of categories and evaluated the theoretical additive ceiling if all signs were corrected.',
      'Compared the additive ceiling against break-even taker fee hurdles across timeframes.',
    ],
    result: 'At 5m, 15m and 1h every trend and higher-timeframe reading, and most volume readings, entered with the wrong sign, and the additive ceiling sat below the cheapest taker breakeven. At 4h and 1d the ceiling cleared the line on samples too small to prove a rule.',
    figures: [
      {
        label: '5m composite information coefficient',
        value: '-0.0151',
        source: { path: 'scripts/research/composite-audit.ts', line: 89 },
      },
      {
        label: '5m additive ceiling',
        value: '0.015802',
        source: { path: 'scripts/research/composite-audit.ts', line: 91 },
      },
      {
        label: '5m standard taker breakeven IC',
        value: '0.1282',
        source: { path: 'scripts/research/composite-audit.ts', line: 94 },
      },
    ],
    research: [
      'Explained why composite scoring systematically failed: individual indicators were predicting in reverse.',
      'Indicated that simply re-weighting existing indicators could not produce an economically viable trading strategy after fees.',
      'The 5m and 1d columns come from pre-v6 reports (2026-09-20), and the 15m, 1h and 4h columns come from v7 (2026-09-26).',
    ],
    references: [
      {
        label: 'Composite sign audit report',
        path: 'scripts/research/composite-audit.ts',
        date: '2026-09-26',
      },
    ],
  },
  {
    id: 'price-score-v1-to-v7',
    name: 'Earlier composite versions (v1 to v7)',
    family: 'price-score',
    status: 'descriptive',
    period: 'Before 2026-10',
    summary: 'Historical development of composite scorer configVersion revisions from initial calibration to causal data corrections.',
    steps: [
      'v2 introduced higher-timeframe confluence and introduced market session data (recorded and used as an entry-only backtest filter).',
      'v3 recalibrated tier cutoffs from production score distributions, lowering buy thresholds from 30 to 24.',
      'v4 enforced evaluation on closed candles only, v5 was the scorer-correctness fixes and the cutoffs they forced, v6 made indicator strength scales scale-free and changed tier cutoffs, and v7 repaired news keyword parsing.',
    ],
    result: 'Successive refinements improved data integrity and causality but did not establish an out-of-sample edge after costs.',
    figures: [
      {
        label: 'v3 buy tier cutoff',
        value: '24',
        source: { path: 'changelogs/CHANGELOG.md', line: 1675 },
      },
      {
        label: 'v6 buy tier cutoff',
        value: '29',
        source: { path: 'changelogs/CHANGELOG.md', line: 1260 },
      },
    ],
    research: [
      'Summarized as a single historical record tracking configVersion changes across the project changelog.',
      'Marked descriptive as earlier versions were exploratory iterations rather than formal gated validation trials.',
    ],
    references: [
      {
        label: 'Project changelog',
        path: 'changelogs/CHANGELOG.md',
      },
      {
        label: 'Compute engine configVersion history',
        path: 'src/lib/signals/compute-engine.ts',
      },
    ],
  },

  // =========================================================================
  // research-program (newest first)
  // =========================================================================
  {
    id: 'research-snipe',
    name: 'Snipe phase extreme conditions',
    family: 'research-program',
    status: 'no-edge',
    period: 'Run 2026-10-10',
    summary: 'Pre-registered discovery and confirmation of rare 1% and 10% tail conditions to detect pre-cost precision edges.',
    steps: [
      'Scanned 38 factor columns across 5m and 1h intervals for 1% and 10% extremes on discovery data (2022 to 2024).',
      'Promoted five candidate cells to confirmation testing on 2025 to 2026 data.',
      'Evaluated win rates on trades with equal 1-ATR target and stop boundaries.',
    ],
    result: 'Detected statistically significant pre-cost reversal edges in two 5m RSI cells, but win rates fell 7.5 to 8.5 points below maker break-even rates.',
    figures: [
      {
        label: 'RSI bottom excess win rate points',
        value: '+1.32',
        source: { path: 'scripts/research/snipe.ts', line: 252 },
      },
      {
        label: 'RSI bottom confirmation win rate',
        value: '0.5035',
        source: { path: 'scripts/research/snipe.ts', line: 252 },
      },
      {
        label: 'RSI top excess win rate points',
        value: '+0.82',
        source: { path: 'scripts/research/snipe.ts', line: 253 },
      },
      {
        label: 'RSI bottom maker breakeven win rate',
        value: '0.589',
        source: { path: 'scripts/research/snipe.ts', line: 260 },
      },
    ],
    research: [
      'Proved that while extreme RSI pushes reverse slightly more often than chance, fee friction makes the effect economically unexploitable.',
      'The RSI reversal is real by every test the lock set, and far too small to trade at 5m.',
      'Part of the edge may be bid-ask bounce in the entry print that kline data cannot separate.',
    ],
    references: [
      {
        label: 'Snipe phase lock',
        path: 'scripts/research/snipe.ts',
        date: '2026-10-10',
      },
    ],
  },
  {
    id: 'research-qh-flow',
    name: 'Quarter-hour flow and trade size',
    family: 'research-program',
    status: 'no-edge',
    period: 'Run 2026-10-09',
    summary: 'Evaluation of opening quarter-hour order imbalance and trade-size-segmented taker flow on clean holdout data.',
    steps: [
      'Extracted and aggregated Binance aggTrades into 5-minute buckets by trade size and 10-second opening intervals.',
      'Tested four imbalance factors across 7 interval-horizon cells on holdout data from November 2024 to June 2026.',
      'Screened using empirical permutation nulls and Benjamini-Hochberg false discovery rate control.',
    ],
    result: 'Closed under kill criterion 2 because none of the predicted columns survived with its predicted sign, with all information coefficients below 0.02.',
    figures: [
      {
        label: 'Small taker imbalance 1h h1 IC',
        value: '-0.0154',
        source: { path: 'scripts/research/qh-flow.ts', line: 272 },
      },
      {
        label: 'Quarter-hour opening imbalance 1h h1 IC',
        value: '-0.0001',
        source: { path: 'scripts/research/qh-flow.ts', line: 269 },
      },
      {
        label: 'Small taker imbalance 1h h1 floor',
        value: '0.0121',
        source: { path: 'scripts/research/qh-flow.ts', line: 240 },
      },
    ],
    research: [
      'Reproduction confirmed the published quarter-hour continuation appeared in-sample but vanished completely out-of-sample.',
      'Small-trade imbalance showed a next-hour reversal at 1h (horizon 1, with a weaker horizon 4) but failed effect size hurdles and taker fee lines.',
    ],
    references: [
      {
        label: 'Quarter-hour flow study lock',
        path: 'scripts/research/qh-flow.ts',
        date: '2026-10-09',
      },
    ],
  },
  {
    id: 'research-broad-trend',
    name: 'Broad trend on survivorship-free universe',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-10-08',
    summary: 'Pre-registered evaluation of five classic trend rules on a point-in-time top 50 perpetual universe.',
    steps: [
      'Assembled a point-in-time top 50 universe drawn from 680 contracts (204 ever members) over 1,948 days (2021 to 2026).',
      'Tested five trend rules (TF1, TF2, TF3, TF4, C3) with daily rebalancing and funding.',
      'Evaluated across nine statistical gates including bootstrap confidence intervals and deflated Sharpe ratio.',
    ],
    result: 'All five trials failed because none passed gate 8 (deflated Sharpe ratio) or gate 2 (confidence interval excluding zero).',
    figures: [
      {
        label: 'TF1 annualized Sharpe ratio',
        value: '0.39',
        source: { path: 'scripts/research/broad-trend.ts', line: 412 },
      },
      {
        label: 'TF1 annualized alpha %',
        value: '+6.6%',
        source: { path: 'scripts/research/broad-trend.ts', line: 412 },
      },
      {
        label: 'TF4 annualized Sharpe ratio',
        value: '0.26',
        source: { path: 'scripts/research/broad-trend.ts', line: 415 },
      },
      {
        label: 'C3 annualized Sharpe ratio',
        value: '0.37',
        source: { path: 'scripts/research/broad-trend.ts', line: 416 },
      },
    ],
    research: [
      'Expanding from 10 survivor coins to a survivorship-free universe cut the Sharpe of the three near misses (TF1, C3, TF4) by 57%, 73% and 80%.',
      'Closed daily trend strategies on Binance USDT-M perpetuals by the pre-registered verdict.',
    ],
    references: [
      {
        label: 'Broad trend study lock',
        path: 'scripts/research/broad-trend.ts',
        date: '2026-10-08',
      },
    ],
  },
  {
    id: 'research-broad-flow',
    name: 'Broad cross-sectional order flow',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-10-08',
    summary: 'Pre-registered test of daily and weekly cross-sectional taker order flow on a survivorship-free top 50 universe.',
    steps: [
      'Constructed daily and weekly standardised taker order flow from base volume on point-in-time top 50 universe.',
      'Tested three trials: daily orthogonalized (DO), weekly raw (W), and weekly orthogonalized (WO).',
      'Evaluated against deflated Sharpe ratio across trials and random permutation benchmarks.',
    ],
    result: 'All trials failed because weekly books achieved insufficient Sharpe ratios to survive multiple testing while daily books lost to 188x turnover costs.',
    figures: [
      {
        label: 'DO annualized Sharpe ratio',
        value: '-2.54',
        source: { path: 'scripts/research/broad-flow.ts', line: 234 },
      },
      {
        label: 'W annualized Sharpe ratio',
        value: '0.53',
        source: { path: 'scripts/research/broad-flow.ts', line: 235 },
      },
      {
        label: 'WO annualized Sharpe ratio',
        value: '0.49',
        source: { path: 'scripts/research/broad-flow.ts', line: 236 },
      },
    ],
    research: [
      'In the literature paper sample period (2021 to 2022) every book lost money, contradicting published gross findings.',
      'Closed daily and weekly cross-sectional taker flow on Binance perpetuals by the pre-registered verdict.',
    ],
    references: [
      {
        label: 'Broad flow study lock',
        path: 'scripts/research/broad-flow.ts',
        date: '2026-10-08',
      },
    ],
  },
  {
    id: 'research-event-studies',
    name: 'Event studies on forced deleveraging and extremes',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-10-08',
    summary: 'Pre-registered test of non-linear events: forced deleveraging, funding extremes, and volume shocks.',
    steps: [
      'Detected forced deleveraging (E1), funding extremes (E2), and volume shocks (E3) using trailing 180-day percentiles.',
      'Measured forward returns across 1h, 4h, and 24h horizons on 10 perpetual contracts from 2022 to 2026.',
      'Evaluated product volatility predictability using next-24h realized variance ratios.',
    ],
    result: 'No directional cell passed because forward returns were either indistinguishable from zero or failed to cover trading costs, though next-day volatility increased by about 1.3 times.',
    figures: [
      {
        label: 'E1 1h gross mean return %',
        value: '-0.079%',
        source: { path: 'scripts/research/event-studies.ts', line: 202 },
      },
      {
        label: 'E3 1h gross mean return %',
        value: '+0.023%',
        source: { path: 'scripts/research/event-studies.ts', line: 208 },
      },
      {
        label: 'Pooled next-day realized variance ratio',
        value: '1.29',
        source: { path: 'scripts/research/event-studies.ts', line: 218 },
      },
    ],
    research: [
      'Kept the volatility reading as a descriptive finding, not a trade.',
      'The comparison with volatility persistence was post hoc, outside the pre-registration.',
    ],
    references: [
      {
        label: 'Event studies lock',
        path: 'scripts/research/event-studies.ts',
        date: '2026-10-08',
      },
    ],
  },
  {
    id: 'research-funding-carry',
    name: 'Funding carry simulation',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-10-02',
    summary: 'Pre-registered simulation of cash-and-carry positions collecting perpetual funding payments.',
    steps: [
      'Simulated long spot and short perpetual positions across 10 symbols over 2023 to 2026.',
      'Compared R0 (always-on carry) against R1 (hysteresis rule trading trailing funding rates).',
      'Evaluated walk-forward performance across seven 6-month windows net of spot and perpetual taker fees.',
    ],
    result: 'The kill criterion fired for both rules because annual net returns (+4.57% and +4.55%) failed to clear the pre-registered 5.0% hurdle.',
    figures: [
      {
        label: 'R0 annual net return %',
        value: '+4.57%',
        source: { path: 'scripts/research/carry-sim.ts', line: 110 },
      },
      {
        label: 'R1 annual net return %',
        value: '+4.55%',
        source: { path: 'scripts/research/carry-sim.ts', line: 111 },
      },
      {
        label: '1x leverage return on capital %',
        value: '+2.27%',
        source: { path: 'scripts/research/carry-sim.ts', line: 137 },
      },
    ],
    research: [
      'Represented the first net return measured in the program whose confidence interval excluded zero, confirming a genuine structural transfer.',
      'However, net yields fell below the 5% a year USDT savings-yield hurdle and trended downward over time (2024: +10.5%, 2025: +1.9%, 2026: -1.7%).',
    ],
    references: [
      {
        label: 'Funding carry study lock',
        path: 'scripts/research/carry-sim.ts',
        date: '2026-10-02',
      },
    ],
  },
  {
    id: 'research-trend-sim',
    name: 'Legends trend and harness simulation',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-10-02',
    summary: 'Pre-registered evaluation of classic published trend-following rules on 10 survivor contracts.',
    steps: [
      'Evaluated four classic trend rules (TF1, TF2, TF3, TF4) and benchmark C3 on 10 symbols over 2019 to 2026.',
      'Evaluated six discrete harness rules (P1 to P4, C1, C2) across listing spans.',
      'Tested gate 8 deflated Sharpe ratio (a statistical test that discounts the best Sharpe ratio for how many variations were tested) across all 11 phase trials.',
    ],
    result: 'Every trial failed gate 8 because the wide variance of trial returns raised the expected maximum Sharpe ratio to 1.52, leaving all deflated Sharpe probabilities below 0.35.',
    figures: [
      {
        label: 'TF1 annualized Sharpe ratio',
        value: '0.91',
        source: { path: 'scripts/research/trend-sim.ts', line: 371 },
      },
      {
        label: 'TF4 annualized Sharpe ratio',
        value: '1.31',
        source: { path: 'scripts/research/trend-sim.ts', line: 374 },
      },
      {
        label: 'C3 annualized Sharpe ratio',
        value: '1.36',
        source: { path: 'scripts/research/trend-sim.ts', line: 375 },
      },
      {
        label: 'Gate 8 expected maximum annual Sharpe',
        value: '1.52',
        source: { path: 'scripts/research/trend-sim.ts', line: 421 },
      },
    ],
    research: [
      'TF1, TF4, and C3 passed individual report gates on survivor coins but failed multiple-testing control.',
      'Led to the requirement that any rule surviving on survivor coins must be tested on a survivorship-free universe, leading to the broad trend phase.',
    ],
    references: [
      {
        label: 'Legends trend simulation lock',
        path: 'scripts/research/trend-sim.ts',
        date: '2026-10-02',
      },
    ],
  },
  {
    id: 'research-frontier',
    name: 'Frequency frontier analysis',
    family: 'research-program',
    status: 'descriptive',
    period: 'Measured 2026-09-26, revised 2026-10-01',
    summary: 'Analytical study deriving required factor predictive strength across trading frequencies and cost structures.',
    steps: [
      'Recovered raw per-trade standard deviation as expectancy divided by observed Sharpe. A first version used confidence-interval-implied deviations and was superseded on 2026-10-01.',
      'Calculated the required information coefficient (IC, a rank correlation measuring how well scores predict future price moves) for factors to cover taker and maker fee hurdles.',
      'Modeled trade frequency against required per-trade predictability to achieve fixed daily return targets.',
    ],
    result: 'Proved that shorter holding periods face steep fee hurdles, requiring information coefficients of 0.2356 at 5m versus 0.0051 at 1d to break even as a taker.',
    figures: [
      {
        label: '5m control taker breakeven IC',
        value: '0.2356',
        source: { path: 'scripts/research/frontier.ts', line: 49 },
      },
      {
        label: '5m control maker breakeven IC',
        value: '0.0471',
        source: { path: 'scripts/research/frontier.ts', line: 49 },
      },
      {
        label: '1h control taker breakeven IC',
        value: '0.0329',
        source: { path: 'scripts/research/frontier.ts', line: 51 },
      },
      {
        label: '1d control taker breakeven IC',
        value: '0.0051',
        source: { path: 'scripts/research/frontier.ts', line: 53 },
      },
    ],
    research: [
      'Corrected on 2026-10-01 when an audit revealed the original calculation used confidence-interval standard deviations that included cross-symbol correlation.',
      'Established the foundational principle that high-frequency intraday alpha must be extraordinarily strong to pay taker fees.',
    ],
    references: [
      {
        label: 'Frequency frontier analysis',
        path: 'scripts/research/frontier.ts',
        date: '2026-10-01',
      },
    ],
  },
  {
    id: 'research-exploration-families',
    name: 'Exploration rule families',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-09-28',
    summary: 'Screening of community-derived trading concepts across multi-year forward-rolling slices.',
    steps: [
      'Tested 37 develop-slice runs of the round 1 rule shapes across the 13-family registry at 15m, 1h, and 4h on data before 2023 (trials 1141 as run, 1186 audited).',
      'Evaluated four options-flow families using newly ingested Deribit data on 2022 history.',
      'Tested candidate promotions on out-of-sample slices using walk-forward statistical gates.',
    ],
    result: 'All rule shapes failed statistical gates in round 1, and all six promoted options candidates failed out-of-sample in 2023.',
    figures: [
      {
        label: 'Round 1 trials run',
        value: '1141',
        source: { path: 'scripts/research/exploration-families.ts', line: 49 },
      },
      {
        label: 'Round 1 audited trial count',
        value: '1186',
        source: { path: 'scripts/research/exploration-families.ts', line: 49 },
      },
    ],
    research: [
      'Options delta-flow continuation showed promising in-sample performance in 2022 bear market conditions but reversed sign in 2023.',
      'Showed that single-regime development slices cannot separate genuine trading rules from era-specific market drift.',
    ],
    references: [
      {
        label: 'Exploration families registry',
        path: 'scripts/research/exploration-families.ts',
        date: '2026-09-28',
      },
    ],
  },
  {
    id: 'research-factors',
    name: 'Factor matrix and screening',
    family: 'research-program',
    status: 'descriptive',
    period: 'Measured 2026-09-26',
    summary: 'Constructed causal per-bar factor matrices and screened factor predictive capacity on time-series and cross-sectional axes.',
    steps: [
      'Computed causal indicator suites, HTF contexts, and raw price/volume factors without lookahead.',
      'Measured factor information coefficients across 15m, 1h, and 4h bars on both time-series and cross-sectional axes.',
      'Applied false discovery rate control at 0.10 over 2,361 evaluated factor cells.',
    ],
    result: 'Kill criterion fired on the time-series axis as no new factor beat maker fee hurdles, while several factors survived cross-sectionally.',
    figures: [
      {
        label: 'Phase B evaluated cells',
        value: '2,361',
        source: { path: 'scripts/research/factors.ts', line: 337 },
      },
      {
        label: 'Phase B cells with the null rejected by FDR (before the size and horizon rules)',
        value: '1,371',
        source: { path: 'scripts/research/factors.ts', line: 337 },
      },
      {
        label: '1h 1-bar return lag-1 IC',
        value: '-0.0291',
        source: { path: 'scripts/research/factors.ts', line: 339 },
      },
    ],
    research: [
      'Established the causal foundation for all subsequent factor research.',
      'The cross-sectional axis carries information not present on the time-series axis. Tradability was left as an open question (scripts/research/factors.ts near line 410).',
    ],
    references: [
      {
        label: 'Factor matrix specification',
        path: 'scripts/research/factors.ts',
        date: '2026-09-26',
      },
    ],
  },
  {
    id: 'research-strategy-families',
    name: 'Strategy families and Phase 4c',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-09-21',
    summary: 'Walk-forward backtests of strategy families derived from Phase 3 factor survivors.',
    steps: [
      'Formulated rules from factor survivors: positioning fade, funding fade, and depth imbalance fade.',
      'Ran walk-forward backtests across six rolling windows with parameter optimization.',
      'Evaluated out-of-sample expectancy, trade counts, bootstrap confidence intervals, and timing tests.',
    ],
    result: 'In two of eight runs (funding-z-fade 15m, depth-imbalance-fade 1h) entries were distinguishable from random entries with the same exit, yet still lost money.',
    figures: [
      {
        label: 'Positioning fade 1d expectancy %',
        value: '+0.752',
        source: { path: 'scripts/research/strategy-families.ts', line: 174 },
      },
      {
        label: 'Funding fade 1h expectancy %',
        value: '-0.143',
        source: { path: 'scripts/research/strategy-families.ts', line: 178 },
      },
      {
        label: 'Depth imbalance fade 4h expectancy %',
        value: '+0.090',
        source: { path: 'scripts/research/strategy-families.ts', line: 180 },
      },
    ],
    research: [
      'positioning-fade 1d missed the timing gate (p 0.055).',
      'Demonstrated that discretely timed entries could not overcome standard exchange taker fee structures.',
    ],
    references: [
      {
        label: 'Strategy families registry and Phase 4c',
        path: 'scripts/research/strategy-families.ts',
        date: '2026-09-21',
      },
    ],
  },
  {
    id: 'research-exposure-gates',
    name: 'Banded-exposure validation gates',
    family: 'research-program',
    status: 'rejected',
    period: 'Run 2026-09-21',
    summary: 'Pre-registered test of continuous banded-exposure portfolio management on positioning factors.',
    steps: [
      'Constructed continuous banded-exposure rules on positioning factors at 1d and 4h intervals to reduce turnover.',
      'Adapted eight validation gates from discrete trades to continuous bar returns.',
      'Evaluated across 6 rolling windows with deflated Sharpe ratio multiple-testing controls.',
    ],
    result: 'The pre-registered falsification criterion fired as all confidence intervals spanned zero and jackknife tests failed, with the optimizer consistently choosing the zero-band control.',
    figures: [
      {
        label: 'PositioningZ180 1d mean % per bar',
        value: '-0.0148',
        source: { path: 'scripts/research/exposure-gates.ts', line: 11 },
      },
      {
        label: 'PositioningZ360 1d mean % per bar',
        value: '+0.0042',
        source: { path: 'scripts/research/exposure-gates.ts', line: 12 },
      },
      {
        label: 'PositioningZ360 4h mean % per bar',
        value: '-0.0027',
        source: { path: 'scripts/research/exposure-gates.ts', line: 15 },
      },
    ],
    research: [
      'Discovered that selection metrics based on per-period Sharpe ratio inherently penalize banded rebalancing in favor of smooth continuous rebalancing.',
      'Closed the backtest track on this dataset by the pre-registered verdict.',
      'The 1d rows were computed while one funding settlement per bar was charged, a two-thirds undercharge, fixed in code but not re-run, while the 4h rows are unaffected (scripts/research/exposure-gates.ts near line 26).',
      'band = 0 won at 4h 6 of 6 and at 1d 5 of 6, so the grid effectively tested no band (scripts/research/exposure-gates.ts line 37).',
    ],
    references: [
      {
        label: 'Banded-exposure validation gates',
        path: 'scripts/research/exposure-gates.ts',
        date: '2026-09-21',
      },
    ],
  },
  {
    id: 'research-factor-ic',
    name: 'Phase 3 factor information coefficients',
    family: 'research-program',
    status: 'descriptive',
    period: 'Run 2026-09-18',
    summary: 'Systematic information coefficient measurement of 40 technical, order flow, and positioning factors across multiple horizons.',
    steps: [
      'Measured Spearman rank correlation (information coefficient, a rank correlation measuring how well scores predict future price moves) for 40 factors against forward returns across horizons from 1 to 32 bars.',
      'Tested across 5m, 1h, 4h, and 1d intervals on 10 symbols over 2022 to June 2026.',
      'Applied consistency rules requiring sign agreement in 60% of quarters and 7 of 10 symbols.',
    ],
    result: 'Intraday factors showed pervasive mean reversion rather than continuation, with trend-following indicators negatively correlated with forward returns.',
    figures: [
      {
        label: '5m surviving factors count',
        value: '21 of 30',
        source: { path: 'scripts/research/factor-ic.ts', line: 26 },
      },
      {
        label: '1h surviving factors count',
        value: '18 of 40',
        source: { path: 'scripts/research/factor-ic.ts', line: 26 },
      },
      {
        label: '4h surviving factors count',
        value: '4 of 40',
        source: { path: 'scripts/research/factor-ic.ts', line: 27 },
      },
      {
        label: '1d surviving factors count',
        value: '2 of 35',
        source: { path: 'scripts/research/factor-ic.ts', line: 27 },
      },
    ],
    research: [
      'Provided the empirical evidence showing that momentum and trend indicators have inverted signs at intraday horizons.',
      'Filtered 40 raw factors down to the surviving candidate subset evaluated in subsequent strategy phases.',
    ],
    references: [
      {
        label: 'Phase 3 factor IC study',
        path: 'scripts/research/factor-ic.ts',
        date: '2026-09-18',
      },
    ],
  },
] as const;
