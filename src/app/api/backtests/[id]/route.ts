import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { BacktestResult } from '@/lib/models/backtest-result';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  await connectDB();
  const result = await BacktestResult.findOne({
    _id: id,
    userId: session.user.id,
  });

  if (!result) {
    return NextResponse.json({ error: 'Backtest result not found' }, { status: 404 });
  }

  return NextResponse.json({ result });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  await connectDB();
  const result = await BacktestResult.findOneAndDelete({
    _id: id,
    userId: session.user.id,
  });

  if (!result) {
    return NextResponse.json({ error: 'Backtest result not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
