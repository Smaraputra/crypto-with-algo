import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { Alert } from '@/lib/models/alert';
import { ALERT_TYPES, ALERT_STATUSES } from '@/types/alert';

const MAX_ALERTS_PER_USER = 50;

const createSchema = z
  .object({
    symbol: z.string().optional(),
    portfolioId: z.string().optional(),
    type: z.enum(ALERT_TYPES),
    targetPrice: z.number().positive().optional(),
    percentChange: z.number().optional(),
    referencePrice: z.number().positive().optional(),
    recurring: z.boolean().optional(),
    cooldownMinutes: z.number().int().min(1).max(1440).optional(),
    message: z.string().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    const priceTypes = ['price_above', 'price_below'] as const;
    const pctPriceTypes = ['price_change_pct'] as const;
    const portfolioValueTypes = [
      'portfolio_value_above',
      'portfolio_value_below',
    ] as const;
    const holdingTypes = ['holding_change_pct'] as const;

    if (
      (priceTypes as readonly string[]).includes(data.type) ||
      (pctPriceTypes as readonly string[]).includes(data.type)
    ) {
      if (!data.symbol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Symbol is required for price alerts',
          path: ['symbol'],
        });
      }
    }

    if ((priceTypes as readonly string[]).includes(data.type)) {
      if (data.targetPrice === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Target price is required for price above/below alerts',
          path: ['targetPrice'],
        });
      }
    }

    if ((pctPriceTypes as readonly string[]).includes(data.type)) {
      if (data.percentChange === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Percent change is required for price change alerts',
          path: ['percentChange'],
        });
      }
    }

    if ((portfolioValueTypes as readonly string[]).includes(data.type)) {
      if (!data.portfolioId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Portfolio ID is required for portfolio value alerts',
          path: ['portfolioId'],
        });
      }
      if (data.targetPrice === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Target price is required for portfolio value alerts',
          path: ['targetPrice'],
        });
      }
    }

    if ((holdingTypes as readonly string[]).includes(data.type)) {
      if (!data.portfolioId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Portfolio ID is required for holding alerts',
          path: ['portfolioId'],
        });
      }
      if (!data.symbol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Symbol is required for holding alerts',
          path: ['symbol'],
        });
      }
      if (data.percentChange === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Percent change is required for holding change alerts',
          path: ['percentChange'],
        });
      }
    }
  });

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await connectDB();

  const statusFilter = req.nextUrl.searchParams.get('status');
  const query: Record<string, string> = { userId: session.user.id };
  if (
    statusFilter &&
    (ALERT_STATUSES as readonly string[]).includes(statusFilter)
  ) {
    query.status = statusFilter;
  }

  const alerts = await Alert.find(query).sort({ createdAt: -1 });
  return NextResponse.json({ alerts });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  await connectDB();

  const count = await Alert.countDocuments({ userId: session.user.id });
  if (count >= MAX_ALERTS_PER_USER) {
    return NextResponse.json(
      { error: `Maximum of ${MAX_ALERTS_PER_USER} alerts per user` },
      { status: 400 }
    );
  }

  const alert = await Alert.create({
    userId: session.user.id,
    ...parsed.data,
  });

  return NextResponse.json({ alert }, { status: 201 });
}
