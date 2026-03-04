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
    console.error('Failed to fetch sentiment:', err);
    return NextResponse.json({ error: 'Failed to fetch sentiment' }, { status: 500 });
  }
}
