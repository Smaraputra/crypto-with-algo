import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry } from '@/lib/models/journal-entry';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';
import { serializeJournalEntry } from '@/lib/journal/times';
import { deleteScreenshotFile, readScreenshot } from '@/lib/journal/screenshots';

export const runtime = 'nodejs';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { fileId } = await params;
  if (!mongoose.isValidObjectId(fileId)) {
    return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
  }

  await connectDB();
  const result = await readScreenshot(fileId, session.user.id);
  if (!result) {
    return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
  }

  return new NextResponse(result.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': result.contentType,
      'Content-Length': String(result.bytes.byteLength),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  const { fileId } = await params;
  if (!mongoose.isValidObjectId(fileId)) {
    return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
  }

  await connectDB();
  const objectId = new mongoose.Types.ObjectId(fileId);

  const updated = await JournalEntry.findOneAndUpdate(
    { userId: session.user.id, 'screenshots.fileId': objectId },
    { $pull: { screenshots: { fileId: objectId } } },
    { returnDocument: 'after' }
  );

  if (!updated) {
    return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
  }

  await deleteScreenshotFile(fileId);

  return NextResponse.json(
    { entry: serializeJournalEntry(updated) },
    { status: 200 }
  );
}
