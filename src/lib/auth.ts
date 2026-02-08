import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import GitHub from 'next-auth/providers/github';
import { MongoDBAdapter } from '@auth/mongodb-adapter';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { connectDB } from './mongodb';
import { User } from './models/user';
import type { MongoClient } from 'mongodb';
import mongoose from 'mongoose';

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
});

async function getMongoClient(): Promise<MongoClient> {
  await connectDB();
  return mongoose.connection.getClient() as unknown as MongoClient;
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

  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    image: user.image,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: MongoDBAdapter(getMongoClient),
  session: { strategy: 'jwt' },
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
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id!;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.id) {
        session.user.id = token.id;
      }
      return session;
    },
  },
});
