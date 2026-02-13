import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { SignalTemplate } from '@/lib/models/signal-template';

/**
 * GET /api/signal-templates
 * List all active signal templates
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await connectDB();

    const templates = await SignalTemplate.find({ active: true })
      .sort({ tradingStyle: 1 })
      .lean();

    return NextResponse.json({ templates });
  } catch (error) {
    console.error('Failed to fetch signal templates:', error);
    return NextResponse.json(
      { error: 'Failed to fetch signal templates' },
      { status: 500 }
    );
  }
}
