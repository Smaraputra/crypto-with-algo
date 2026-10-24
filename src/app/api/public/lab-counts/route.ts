import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { createRateLimiter, rateLimit } from '@/lib/rate-limit';
import { cachedFetch } from '@/lib/redis';
import { labStatusCounts } from '@/lib/signals/lab/status-counts';
import { LEDGER_TOTAL } from '@/content/research/catalog';

const limiter = createRateLimiter(30, 60);

/**
 * One rejected rule: rv-v1, as counted in useLabSummary (src/components/lab/useLabSummary.ts).
 */
export const REJECTED_RULES = 1;

export interface PublicLabCountsResponse {
  underTest: number;
  validated: number;
  notStarted: number;
  hypotheses: number;
  rejectedRules: number;
  ledgerTrials: number;
  asOf: string;
}

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req, limiter);
  if (limited) return limited;

  try {
    const data = await cachedFetch<PublicLabCountsResponse>(
      'public-lab-counts',
      async () => {
        await connectDB();
        const counts = await labStatusCounts();
        return {
          ...counts,
          rejectedRules: REJECTED_RULES,
          ledgerTrials: LEDGER_TOTAL,
          asOf: new Date().toISOString(),
        };
      },
      300
    );

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    });
  } catch (error) {
    console.error(
      'Failed to fetch public lab counts:',
      error instanceof Error ? error.message : 'Unknown error'
    );
    return NextResponse.json(
      { error: 'Lab counts are unavailable' },
      { status: 502 }
    );
  }
}
