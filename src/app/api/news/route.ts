import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { fetchCryptoNews } from '@/lib/external/crypto-news';

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const categories = req.nextUrl.searchParams.get('categories') || undefined;

  try {
    const articles = await fetchCryptoNews(categories);
    return NextResponse.json({ articles });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch news';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
