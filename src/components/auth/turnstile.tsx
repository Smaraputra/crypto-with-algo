'use client';

import { useEffect } from 'react';
import { Turnstile } from '@marsidev/react-turnstile';

interface TurnstileWidgetProps {
  onToken: (token: string) => void;
}

// Cloudflare's documented testing site keys do not solve a real challenge and do
// not reliably auto-complete under headless browser automation. When one is
// configured (CI / E2E), skip the real widget and provide a deterministic token
// so automated tests are not gated on Cloudflare's challenge platform.
const TEST_SITE_KEYS = new Set([
  '1x00000000000000000000AA', // always passes
  '2x00000000000000000000AB', // always blocks
  '3x00000000000000000000FF', // forces interactive
]);

export function TurnstileWidget({ onToken }: TurnstileWidgetProps) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const isTestKey = !!siteKey && TEST_SITE_KEYS.has(siteKey);

  useEffect(() => {
    if (isTestKey) onToken('test-turnstile-token');
  }, [isTestKey, onToken]);

  if (!siteKey) return null;
  if (isTestKey) return <div data-testid="turnstile-test-stub" />;

  return (
    <Turnstile
      siteKey={siteKey}
      onSuccess={onToken}
      onExpire={() => onToken('')}
      onError={() => onToken('')}
      options={{ theme: 'dark' }}
    />
  );
}
