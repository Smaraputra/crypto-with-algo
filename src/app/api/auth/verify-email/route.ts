import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/mongodb';
import { User } from '@/lib/models/user';
import { consumeToken } from '@/lib/auth-tokens';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const schema = z.object({ token: z.string().min(1) });
const limiter = createRateLimiter(10, 60);

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, limiter);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Token is required' }, { status: 400 });
  }

  const userId = await consumeToken(parsed.data.token, 'verify');
  if (!userId) {
    return NextResponse.json(
      { error: 'This verification link is invalid or has expired.' },
      { status: 400 }
    );
  }

  await connectDB();
  await User.updateOne({ _id: userId }, { $set: { emailVerified: new Date() } });
  return NextResponse.json({ ok: true }, { status: 200 });
}
