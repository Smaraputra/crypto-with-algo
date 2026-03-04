import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { SignalTemplate, type TradingStyle } from '@/lib/models/signal-template';
import { z } from 'zod';

const paramsSchema = z.object({
  style: z.enum(['scalping', 'day_trading', 'swing_trading', 'position_trading']),
});

/**
 * GET /api/signal-templates/:style
 * Get the active template for a specific trading style
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ style: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = await context.params;
    const parsed = paramsSchema.safeParse(params);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid trading style', issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { style } = parsed.data;

    await connectDB();

    const template = await SignalTemplate.findOne({
      tradingStyle: style as TradingStyle,
      active: true,
    })
      .sort({ version: -1 })
      .lean();

    if (!template) {
      return NextResponse.json(
        { error: `No active template found for ${style}` },
        { status: 404 }
      );
    }

    return NextResponse.json({ template });
  } catch (error) {
    console.error('Failed to fetch signal template:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Failed to fetch signal template' },
      { status: 500 }
    );
  }
}
