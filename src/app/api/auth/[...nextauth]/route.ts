import { NextRequest } from 'next/server';
import { handlers } from '@/lib/auth';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';

const loginLimiter = createRateLimiter(10, '60 s');

export const { GET } = handlers;

export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, loginLimiter, { failClosed: true });
  if (limited) return limited;

  return handlers.POST(req);
}
