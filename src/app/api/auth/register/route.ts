import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { connectDB } from '@/lib/mongodb';
import { User } from '@/lib/models/user';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const registerSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.email(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(
      /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/,
      'Password must contain at least one uppercase letter, one digit, and one special character'
    ),
});

const limiter = createRateLimiter(5, '60 s');

export async function POST(req: NextRequest) {
  if (process.env.ALLOW_REGISTRATION !== 'true') {
    return NextResponse.json(
      { error: 'Registration is currently disabled' },
      { status: 403 }
    );
  }

  const limited = await rateLimit(req, limiter, { failClosed: true });
  if (limited) return limited;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    await connectDB();

    const existingUser = await User.findOne({ email: parsed.data.email });
    if (existingUser) {
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
      {
        id: user._id.toString(),
        name: parsed.data.name,
        email: parsed.data.email,
      },
      { status: 201 }
    );
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 11000) {
      return NextResponse.json(
        { error: 'Email already registered' },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
