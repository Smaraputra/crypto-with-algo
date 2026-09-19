import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { connectDB } from '@/lib/mongodb';
import { LlmCall, LLM_CALL_INTERVALS } from '@/lib/models/llm-call';
import { authorizeLlmPanel } from './auth';
import { createLlmCall, FreshnessError, llmCallBodySchema } from './create-call';

const MAX_LIMIT = 200;

const listSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9]{5,20}$/).optional(),
  interval: z.enum(LLM_CALL_INTERVALS).optional(),
  limit: z.coerce.number().int().min(1).default(50),
});

export async function POST(req: NextRequest) {
  const auth = await authorizeLlmPanel(req);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = llmCallBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  await connectDB();
  try {
    const { call, created } = await createLlmCall(parsed.data, Date.now());
    return NextResponse.json({ call, created }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof FreshnessError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function GET(req: NextRequest) {
  const auth = await authorizeLlmPanel(req);
  if (!auth.ok) return NextResponse.json(auth.body, { status: auth.status });

  const parsed = listSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { symbol, interval } = parsed.data;
  const limit = Math.min(parsed.data.limit, MAX_LIMIT);
  const filter: Record<string, unknown> = {};
  if (symbol) filter.symbol = symbol;
  if (interval) filter.interval = interval;

  await connectDB();
  const calls = await LlmCall.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  return NextResponse.json({ calls });
}
