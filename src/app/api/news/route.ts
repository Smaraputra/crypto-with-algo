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
    console.error('Failed to fetch news:', err);
    return NextResponse.json({ error: 'Failed to fetch news' }, { status: 500 });
  }
}
