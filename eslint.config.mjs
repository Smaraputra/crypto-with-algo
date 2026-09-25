import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

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
]);

export default eslintConfig;
