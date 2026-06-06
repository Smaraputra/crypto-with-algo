import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import { MongoDBAdapter } from '@auth/mongodb-adapter';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { connectDB } from './mongodb';
import { User } from './models/user';
import { MongoClient } from 'mongodb';

export class EmailNotVerifiedError extends CredentialsSignin {
  code = 'email_not_verified';
}

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
});

let adapterClient: MongoClient | null = null;

async function getMongoClient(): Promise<MongoClient> {
  if (adapterClient) return adapterClient;
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/cryptowithalgo';
  adapterClient = new MongoClient(uri);
  await adapterClient.connect();
  return adapterClient;
}

export async function authorizeCredentials(
  credentials: unknown
): Promise<{ id: string; name: string; email: string; image?: string } | null> {
  const parsed = loginSchema.safeParse(credentials);
  if (!parsed.success) return null;

  await connectDB();
  const user = await User.findOne({ email: parsed.data.email });
  if (!user?.password) return null;

  const passwordMatch = await bcrypt.compare(
    parsed.data.password,
    user.password
  );
  if (!passwordMatch) return null;

  if (!user.emailVerified) {
    throw new EmailNotVerifiedError();
  }

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    image: user.image,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  adapter: MongoDBAdapter(getMongoClient),
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 },
  pages: {
    signIn: '/login',
  },
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: authorizeCredentials,
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account && account.provider !== 'credentials' && user?.id) {
        // Auto-verify OAuth users (the provider already confirmed the email).
        // Non-essential: never block an otherwise-valid OAuth login on a DB hiccup.
        try {
          await connectDB();
          // `emailVerified: null` matches both null (adapter default) and missing,
          // and excludes already-verified users (a Date), so this is idempotent.
          await User.updateOne(
            { _id: user.id, emailVerified: null },
            { $set: { emailVerified: new Date() } }
          );
        } catch (err) {
          console.error('OAuth emailVerified update failed:', err);
        }
      }
      return true;
    },
    async jwt({ token, user, trigger, session: updateData }) {
      if (user) {
        token.id = user.id!;
        // On sign-in, check if user has accepted ToS
        await connectDB();
        const dbUser = await User.findById(user.id).select('tosAcceptedAt').lean();
        token.tosAccepted = !!(dbUser && 'tosAcceptedAt' in dbUser && dbUser.tosAcceptedAt);
      }
      if (trigger === 'update') {
        // Client called update({ tosAccepted: true }) after consent
        if (updateData?.tosAccepted) {
          // Verify against DB before trusting client claim
          await connectDB();
          const dbUser = await User.findById(token.id).select('tosAcceptedAt').lean();
          token.tosAccepted = !!(dbUser && 'tosAcceptedAt' in dbUser && dbUser.tosAcceptedAt);
        }
      }
      if (token.tosAccepted === undefined) {
        // Migration: pre-consent JWT lacks the field entirely
        await connectDB();
        const dbUser = await User.findById(token.id).select('tosAcceptedAt').lean();
        token.tosAccepted = !!(dbUser && 'tosAcceptedAt' in dbUser && dbUser.tosAcceptedAt);
      }
      return token;
    },
    async session({ session, token }) {
      if (token.id) {
        session.user.id = token.id;
      }
      session.user.tosAccepted = !!token.tosAccepted;
      return session;
    },
  },
});
