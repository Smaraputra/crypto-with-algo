import crypto from 'crypto';
import { connectDB } from '@/lib/mongodb';
import { AuthToken, type AuthTokenType } from '@/lib/models/auth-token';

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function createToken(
  userId: string,
  type: AuthTokenType,
  ttlSeconds: number
): Promise<string> {
  await connectDB();
  await AuthToken.deleteMany({ userId, type });

  const raw = crypto.randomBytes(32).toString('hex');
  await AuthToken.create({
    userId,
    type,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
  return raw;
}

export async function consumeToken(
  rawToken: string,
  type: AuthTokenType
): Promise<string | null> {
  await connectDB();
  const doc = await AuthToken.findOne({
    tokenHash: hashToken(rawToken),
    type,
    expiresAt: { $gt: new Date() },
  });
  if (!doc) return null;

  await AuthToken.deleteOne({ _id: doc._id });
  return doc.userId.toString();
}
