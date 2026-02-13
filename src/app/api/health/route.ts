import { NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';

export const dynamic = 'force-dynamic';

const READY_STATES: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

export async function GET() {
  let mongoStatus: string;
  let isHealthy: boolean;

  try {
    await connectDB();
    const readyState = mongoose.connection.readyState;
    mongoStatus = READY_STATES[readyState] ?? 'unknown';
    isHealthy = readyState === 1;
  } catch {
    mongoStatus = 'error';
    isHealthy = false;
  }

  const body = {
    status: isHealthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    mongodb: mongoStatus,
  };

  return NextResponse.json(body, { status: isHealthy ? 200 : 503 });
}
