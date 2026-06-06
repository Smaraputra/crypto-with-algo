'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}

type VerifyStatus = 'verifying' | 'success' | 'error';

function VerifyEmailContent() {
  const token = useSearchParams().get('token');

  if (token) {
    return <TokenVerifier token={token} />;
  }

  return <ResendForm />;
}

function TokenVerifier({ token }: { token: string }) {
  const [status, setStatus] = useState<VerifyStatus>('verifying');
  const calledRef = useRef(false);

  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then((res) => {
        setStatus(res.ok ? 'success' : 'error');
      })
      .catch(() => setStatus('error'));
  }, [token]);

  if (status === 'verifying') {
    return (
      <Card className="border-border/50">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Verifying...</CardTitle>
          <CardDescription>Please wait while we verify your email.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (status === 'success') {
    return (
      <Card className="border-border/50">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Email verified</CardTitle>
          <CardDescription>You can now sign in to your account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <Link href="/login">
            <Button>Sign in</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  // error state - show error and resend form so user can retry
  return (
    <div className="space-y-4">
      <Card className="border-border/50">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Verification failed</CardTitle>
          <CardDescription>
            This link may have expired. Use the form below to request a new verification email.
          </CardDescription>
        </CardHeader>
      </Card>
      <ResendForm />
    </div>
  );
}

function ResendForm() {
  const [email, setEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!turnstileToken) return;
    setLoading(true);

    await fetch('/api/auth/verify-email/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, turnstileToken }),
    });

    setLoading(false);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <Card className="border-border/50">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">Check your inbox</CardTitle>
          <CardDescription>
            If your account needs verification, an email is on the way.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="text-primary hover:underline">
            Back to sign in
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">Resend verification</CardTitle>
        <CardDescription>
          Enter your email address and we will send you a new verification link.
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
          <Button type="submit" className="w-full" disabled={!turnstileToken || loading}>
            {loading ? 'Sending...' : 'Send verification email'}
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
