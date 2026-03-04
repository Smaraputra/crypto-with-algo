'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export default function ConsentPage() {
  const router = useRouter();
  const { update } = useSession();
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleConsent() {
    if (!accepted) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/consent', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to record consent');
        setLoading(false);
        return;
      }
      // Trigger JWT refresh so tosAccepted is updated in the session
      await update();
      router.push('/dashboard');
    } catch {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  }

  return (
    <Card className="border-border/50">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">Terms & Privacy</CardTitle>
        <CardDescription>
          Please review and accept our terms before continuing
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          To use CryptoWithAlgo, you must agree to our{' '}
          <Link href="/terms" className="text-primary hover:underline" target="_blank">
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link href="/privacy" className="text-primary hover:underline" target="_blank">
            Privacy Policy
          </Link>
          .
        </p>

        <div className="flex items-start gap-3 rounded-md border border-border p-4">
          <Checkbox
            id="accept-tos"
            checked={accepted}
            onCheckedChange={(checked) => setAccepted(checked === true)}
          />
          <Label htmlFor="accept-tos" className="text-sm leading-relaxed cursor-pointer">
            I have read and agree to the Terms of Service and Privacy Policy
          </Label>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          className="w-full"
          disabled={!accepted || loading}
          onClick={handleConsent}
        >
          {loading ? 'Continuing...' : 'Continue'}
        </Button>
      </CardFooter>
    </Card>
  );
}
