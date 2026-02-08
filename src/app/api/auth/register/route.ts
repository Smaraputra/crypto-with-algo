import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { connectDB } from '@/lib/mongodb';
import { User } from '@/lib/models/user';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.email(),
  password: z.string().min(6).max(100),
});

const limiter = createRateLimiter(5, '60 s');

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, limiter);
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();

  const existing = await User.findOne({ email: parsed.data.email });
  if (existing) {
    return NextResponse.json(
      { error: 'Email already registered' },
      { status: 409 }
    );
  }

  const hashedPassword = await bcrypt.hash(parsed.data.password, 12);
  const user = await User.create({
    name: parsed.data.name,
    email: parsed.data.email,
    password: hashedPassword,
  });

  return NextResponse.json(
    { id: user._id.toString(), name: user.name, email: user.email },
    { status: 201 }
  );
}
