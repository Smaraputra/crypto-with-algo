'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TurnstileWidget } from '@/components/auth/turnstile';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);

    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, turnstileToken }),
      });
    } catch {
      // intentionally swallow - always show neutral confirmation
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  }

  if (submitted) {
    return (
      <Card className="border-border/50">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Check your inbox</CardTitle>
          <CardDescription>
            If an account exists with that email, a password reset link is on the way.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Link href="/login" className="text-primary hover:underline text-sm">
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">Reset your password</CardTitle>
        <CardDescription>
          Enter your email address and we&apos;ll send you a reset link.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <TurnstileWidget onToken={setTurnstileToken} />
          <Button
            type="submit"
            className="w-full"
            disabled={!turnstileToken || loading}
          >
            {loading ? 'Sending...' : 'Send reset link'}
          </Button>
        </form>
        <div className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="text-primary hover:underline">
            Back to sign in
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
