import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { connectDB } from '@/lib/mongodb';
import { User } from '@/lib/models/user';
import { createToken } from '@/lib/auth-tokens';
import { sendEmail } from '@/lib/email/mailer';
import { passwordResetEmail } from '@/lib/email/templates';
import { verifyTurnstile } from '@/lib/turnstile';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const schema = z.object({ email: z.email(), turnstileToken: z.string().min(1) });
const limiter = createRateLimiter(3, 3600);

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
    return NextResponse.json({ error: 'Validation failed' }, { status: 400 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (!(await verifyTurnstile(parsed.data.turnstileToken, ip))) {
    return NextResponse.json({ error: 'Verification challenge failed' }, { status: 400 });
  }

  await connectDB();
  const user = await User.findOne({ email: parsed.data.email });
  if (user && user.password) {
    try {
      const token = await createToken(user._id.toString(), 'reset', 3600);
      const url = `${process.env.NEXTAUTH_URL}/reset-password?token=${token}`;
      await sendEmail({ to: user.email, ...passwordResetEmail({ name: user.name, url }) });
    } catch (err) {
      console.error('Password reset email failed:', err);
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
