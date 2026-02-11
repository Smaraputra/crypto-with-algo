import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { fetchFearAndGreed } from '@/lib/external/fear-greed';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const sentiment = await fetchFearAndGreed();
    return NextResponse.json({ sentiment });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch sentiment';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
