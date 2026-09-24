import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { connectDB } from '@/lib/mongodb';
import { LlmCall, LLM_CALL_INTERVALS } from '@/lib/models/llm-call';
import { authorizeLlmPanel } from '../auth';

/**
 * How many calls the record holds, so the panel's own liveness check cannot
 * saturate.
 *
 * WHY THIS EXISTS: the list route caps at `MAX_LIMIT = 200`, so counting a page
 * of it stops being a count the moment an interval passes 200 rows. The VPS
 * wrapper's "stored[...]" line did exactly that and read a flat 200 while 1h
 * actually held 247 -- a monitor that had silently gone blind, which is the
 * same class of failure it was built to catch.
 *
 * Raising the cap would only move the cliff, and shipping every `votes[]` and
 * `rationale` over the wire to compute a scalar is the wrong shape. A `since`
 * window also makes "how many calls in the last two hours" a first-class
 * question rather than something inferred by counting a page.
 *
 * Query params:
 *   symbol    optional, upper-case
 *   interval  optional, one of LLM_CALL_INTERVALS
 *   since     optional, ISO date or epoch ms; filters on createdAt
 */
const querySchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{5,20}$/).optional(),
  interval: z.enum(LLM_CALL_INTERVALS).optional(),
  since: z.string().optional(),
});

function parseSince(raw: string | undefined): Date | null | 'invalid' {
  if (raw === undefined) return null;
  // Epoch milliseconds, or anything Date can parse.
  const asNumber = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(asNumber)) return 'invalid';
  return new Date(asNumber);
}

export async function GET(req: NextRequest) {
  const auth = await authorizeLlmPanel(req);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const since = parseSince(parsed.data.since);
  if (since === 'invalid') {
    return NextResponse.json({ error: 'since must be an ISO date or epoch milliseconds' }, { status: 400 });
  }

  const filter: Record<string, unknown> = {};
  if (parsed.data.symbol) filter.symbol = parsed.data.symbol;
  if (parsed.data.interval) filter.interval = parsed.data.interval;
  if (since) filter.createdAt = { $gte: since };

  try {
    await connectDB();
    const count = await LlmCall.countDocuments(filter);

    return NextResponse.json({
      count,
      symbol: parsed.data.symbol ?? null,
      interval: parsed.data.interval ?? null,
      since: since ? since.toISOString() : null,
    });
  } catch (error) {
    console.error('Error counting llm calls:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
