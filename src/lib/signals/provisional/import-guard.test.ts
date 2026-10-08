// @vitest-environment node
//
// Proves the eslint.config.mjs import guard fires. Scoring is scheduler-only:
// the provisional files must not reach the write path, and the browser files must
// not pull server-only modules into the client bundle.
import path from 'node:path';

import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
const BROWSER_HOOK = 'src/hooks/useProvisionalSignal.ts';
const ROUTE = 'src/app/api/signals/provisional-context/route.ts';
const UNRELATED = 'src/lib/foo.ts';

let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

async function restrictedMessages(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return result.messages
    .filter((m) => m.ruleId === '@typescript-eslint/no-restricted-imports')
    .map((m) => m.message);
}

describe('provisional import guard', () => {
  it('rejects a value import of a write-path model in a browser file', async () => {
    const messages = await restrictedMessages(
      "import { GlobalSignal } from '@/lib/models/global-signal';\nexport const x = GlobalSignal;\n",
      BROWSER_HOOK
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it('allows the same import as a type-only import', async () => {
    const messages = await restrictedMessages(
      "import type { GlobalSignal } from '@/lib/models/global-signal';\nexport type X = GlobalSignal;\n",
      BROWSER_HOOK
    );
    expect(messages).toEqual([]);
  });

  it('rejects compute-engine in the server route', async () => {
    const messages = await restrictedMessages(
      "import { computeSignal } from '@/lib/signals/compute-engine';\nexport const x = computeSignal;\n",
      ROUTE
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it('rejects write-path modules by relative path and paper-desk subpaths', async () => {
    const relative = await restrictedMessages(
      "import { resolve } from '../outcome-resolver';\nexport const x = resolve;\n",
      'src/lib/signals/provisional/styles.ts'
    );
    const paper = await restrictedMessages(
      "import { open } from '@/lib/paper-desk/engine';\nexport const x = open;\n",
      ROUTE
    );
    const paperModel = await restrictedMessages(
      "import { PaperTrade } from '@/lib/models/paper-trade';\nexport const x = PaperTrade;\n",
      ROUTE
    );
    expect(relative.length).toBeGreaterThan(0);
    expect(paper.length).toBeGreaterThan(0);
    expect(paperModel.length).toBeGreaterThan(0);
  });

  it('rejects redis for a browser path but not for the route', async () => {
    const code = "import { cachedFetch } from '@/lib/redis';\nexport const x = cachedFetch;\n";
    expect((await restrictedMessages(code, BROWSER_HOOK)).length).toBeGreaterThan(0);
    expect(await restrictedMessages(code, ROUTE)).toEqual([]);
  });

  it('rejects Node built-ins and next/server in a browser file, allows them as types', async () => {
    for (const spec of ['fs', 'crypto', 'node:path', 'next/server', 'mongoose', '@/lib/mongodb']) {
      const value = await restrictedMessages(`import * as m from '${spec}';\nexport const x = m;\n`, BROWSER_HOOK);
      expect(value.length, spec).toBeGreaterThan(0);
    }
    const typed = await restrictedMessages("import type { NextRequest } from 'next/server';\nexport type X = NextRequest;\n", BROWSER_HOOK);
    expect(typed).toEqual([]);
  });

  it('does not apply to test files or unrelated paths', async () => {
    const code = "import { GlobalSignal } from '@/lib/models/global-signal';\nexport const x = GlobalSignal;\n";
    expect(await restrictedMessages(code, UNRELATED)).toEqual([]);
    expect(await restrictedMessages(code, 'src/hooks/useProvisionalSignal.test.tsx')).toEqual([]);
  });
});
