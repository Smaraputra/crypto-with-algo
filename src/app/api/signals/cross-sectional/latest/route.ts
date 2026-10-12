import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { CrossSectionalSignal } from '@/lib/models/cross-sectional-signal';
import { CrossSectionalBook } from '@/lib/models/cross-sectional-book';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const [signal, book] = await Promise.all([
    CrossSectionalSignal.findOne().sort({ timestamp: -1 }).lean(),
    CrossSectionalBook.findOne({ bookName: 'rv-8h-buffer2' }).lean(),
  ]);

  return NextResponse.json({
    success: true,
    signal: signal ?? null,
    book: book ?? null,
  });
}
