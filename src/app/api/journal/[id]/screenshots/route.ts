import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { JournalEntry } from '@/lib/models/journal-entry';
import { authenticatedLimiter, rateLimitUser } from '@/lib/rate-limit';
import { serializeJournalEntry } from '@/lib/journal/times';
import {
  deleteScreenshotFile,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS_PER_ENTRY,
  sniffImageType,
  storeScreenshot,
} from '@/lib/journal/screenshots';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const limited = await rateLimitUser(session.user.id, authenticatedLimiter);
  if (limited) return limited;

  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_SCREENSHOT_BYTES + 64 * 1024) {
    return NextResponse.json(
      { error: 'Screenshots can be at most 5 MB.' },
      { status: 413 }
    );
  }

  const { id } = await params;
  if (!mongoose.isValidObjectId(id)) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  await connectDB();
  const entry = await JournalEntry.findOne({
    _id: id,
    userId: session.user.id,
  });

  if (!entry) {
    return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Attach an image file.' }, { status: 400 });
  }

  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof (file as Blob).arrayBuffer !== 'function') {
    return NextResponse.json({ error: 'Attach an image file.' }, { status: 400 });
  }

  if ((file as Blob).size > MAX_SCREENSHOT_BYTES) {
    return NextResponse.json(
      { error: 'Screenshots can be at most 5 MB.' },
      { status: 413 }
    );
  }

  const arrayBuffer = await (file as Blob).arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    return NextResponse.json(
      { error: 'Screenshots must be PNG, JPEG or WebP.' },
      { status: 415 }
    );
  }

  if ((entry.screenshots?.length ?? 0) >= MAX_SCREENSHOTS_PER_ENTRY) {
    return NextResponse.json(
      { error: 'An entry holds at most 4 screenshots.' },
      { status: 400 }
    );
  }

  const fileId = await storeScreenshot(bytes, {
    userId: session.user.id,
    entryId: id,
    contentType,
  });

  const updated = await JournalEntry.findOneAndUpdate(
    { _id: id, userId: session.user.id, 'screenshots.3': { $exists: false } },
    {
      $push: {
        screenshots: {
          fileId,
          contentType,
          size: bytes.byteLength,
          uploadedAt: new Date(),
        },
      },
    },
    { new: true }
  );

  if (!updated) {
    await deleteScreenshotFile(fileId);
    return NextResponse.json(
      { error: 'An entry holds at most 4 screenshots.' },
      { status: 400 }
    );
  }

  return NextResponse.json(
    { entry: serializeJournalEntry(updated) },
    { status: 201 }
  );
}
