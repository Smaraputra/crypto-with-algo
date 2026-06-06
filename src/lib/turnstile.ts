const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  token: string,
  remoteip?: string
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('TURNSTILE_SECRET_KEY is not set; skipping Turnstile verification.');
    return true;
  }
  if (!token) return false;

  const body = new URLSearchParams({ secret, response: token });
  if (remoteip) body.set('remoteip', remoteip);

  try {
    const res = await fetch(SITEVERIFY, { method: 'POST', body });
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error('Turnstile verification error:', err);
    return false;
  }
}
