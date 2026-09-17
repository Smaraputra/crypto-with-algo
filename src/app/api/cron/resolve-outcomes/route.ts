import { NextRequest, NextResponse } from 'next/server';

import { verifyCronSecret } from '@/lib/cron-auth';
import { connectDB } from '@/lib/mongodb';
import { resolveDueOutcomes } from '@/lib/signals/outcome-resolver';

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const counts = await resolveDueOutcomes();

  return NextResponse.json(counts);
}
