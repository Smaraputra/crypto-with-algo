import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Files the provisional signal overlay owns. The browser files run in the client
// bundle; the route is the one server file.
const PROVISIONAL_BROWSER_FILES = [
  "src/lib/signals/score-bar.ts",
  "src/lib/signals/provisional/**/*.{ts,tsx}",
  "src/stores/formingBarStore.ts",
  "src/hooks/useProvisionalSignal.ts",
  "src/components/chart/signal-score-indicator.ts",
  "src/components/chart/SignalScoreStrip.tsx",
  "src/components/chart/TradingChart.tsx",
  "src/components/chart/DashboardChart.tsx",
];
const PROVISIONAL_SERVER_FILES = ["src/app/api/signals/provisional-context/route.ts"];
const TEST_FILES = ["**/*.test.*"];

// Each pattern covers the alias form and the relative form of the module.
const WRITE_PATH_PATTERNS = [
  "compute-engine",
  "outcome-resolver",
  "models/global-signal",
  "models/signal-outcome",
  "models/paper-*",
  "paper-desk",
  "paper-desk/**",
].map((name) => `**/${name}`);

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "_reference/**",
    // A git worktree lives inside the repo at .claude/worktrees/<branch>. It is
    // a second checkout of this same tree, so linting it doubles every file and
    // reports its own .next build output as thousands of errors -- which buries
    // the real ones and makes the "zero lint errors" step rule unsatisfiable.
    // Git already excludes it (.git/info/exclude); ESLint did not.
    ".claude/worktrees/**",
  ]),
  // Scheduler-only scoring: the provisional overlay is display-only and must never
  // be able to reach the write path (GlobalSignal inserts, pending outcomes, the
  // paper desk), even by a careless future edit. Type imports stay allowed.
  {
    files: [...PROVISIONAL_BROWSER_FILES, ...PROVISIONAL_SERVER_FILES],
    ignores: TEST_FILES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: WRITE_PATH_PATTERNS,
              allowTypeImports: true,
              message:
                "Scoring is scheduler-only: provisional-signal files must not import the write path (compute-engine, outcome-resolver, GlobalSignal/SignalOutcome/paper models, paper-desk).",
            },
          ],
        },
      ],
    },
  },
  // Client bundle safety: the browser files must not pull server-only modules
  // (databases, Redis, Node built-ins, next/server) into the client bundle.
  // Type imports are erased at build time, so they stay allowed. Declared after
  // the write-path block, so it carries both groups for the browser files.
  {
    files: PROVISIONAL_BROWSER_FILES,
    ignores: TEST_FILES,
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            "mongoose",
            "mongodb",
            "@/lib/mongodb",
            "@/lib/redis",
            "@/lib/candle-ingestion",
            "@/lib/signals/scoring-inputs",
            "next/server",
            "fs",
            "crypto",
          ].map((name) => ({
            name,
            allowTypeImports: true,
            message: "Server-only module: keep it out of the client bundle (type imports are fine).",
          })),
          patterns: [
            {
              group: [
                "@/lib/models/*",
                "**/lib/models/*",
                "node:*",
                ...WRITE_PATH_PATTERNS,
              ],
              allowTypeImports: true,
              message:
                "Server-only or write-path module: keep it out of the client bundle (type imports are fine).",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
