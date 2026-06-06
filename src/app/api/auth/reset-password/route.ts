import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { connectDB } from '@/lib/mongodb';
import { User } from '@/lib/models/user';
import { consumeToken } from '@/lib/auth-tokens';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const schema = z.object({
  token: z.string().min(1),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(
      /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/,
      'Password must contain at least one uppercase letter, one digit, and one special character'
    ),
});
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
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const userId = await consumeToken(parsed.data.token, 'reset');
  if (!userId) {
    return NextResponse.json(
      { error: 'This reset link is invalid or has expired.' },
      { status: 400 }
    );
  }

  const hashed = await bcrypt.hash(parsed.data.password, 12);
  await connectDB();
  await User.updateOne(
    { _id: userId },
    { $set: { password: hashed, emailVerified: new Date() } }
  );
  return NextResponse.json({ ok: true }, { status: 200 });
}
