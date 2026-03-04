import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { getHistoricalSnapshots } from '@/lib/historical-snapshots';
import { z } from 'zod';

const querySchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']),
  startTime: z.coerce.number().positive(),
  endTime: z.coerce.number().positive(),
});

export async function GET(request: Request) {
  try {
    // Auth check
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Parse query params
    const { searchParams } = new URL(request.url);
    const params = {
      symbol: searchParams.get('symbol'),
      interval: searchParams.get('interval'),
      startTime: searchParams.get('startTime'),
      endTime: searchParams.get('endTime'),
    };

    const parsed = querySchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid query parameters', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { symbol, interval, startTime, endTime } = parsed.data;

    // Validate time range (max 1 year)
    const maxRange = 365 * 24 * 60 * 60 * 1000; // 1 year
    if (endTime - startTime > maxRange) {
      return NextResponse.json(
        { error: 'Time range too large (max 1 year)' },
        { status: 400 }
      );
    }

    await connectDB();
    const snapshots = await getHistoricalSnapshots(symbol, interval, startTime, endTime);

    return NextResponse.json({ snapshots, count: snapshots.length });
  } catch (error) {
    console.error('Failed to fetch historical snapshots:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Failed to fetch historical snapshots' },
      { status: 500 }
    );
  }
}
