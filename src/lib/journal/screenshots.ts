import mongoose from 'mongoose';
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS_PER_ENTRY,
  type ScreenshotType,
} from '@/types/journal';

export { MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS_PER_ENTRY, type ScreenshotType };

export const SCREENSHOT_BUCKET = 'journalScreenshots';

export type GridFSBucket = mongoose.mongo.GridFSBucket;

export function sniffImageType(bytes: Uint8Array): ScreenshotType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }

  return null;
}

export function screenshotBucket(): mongoose.mongo.GridFSBucket {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection is not open');
  }
  return new mongoose.mongo.GridFSBucket(db, { bucketName: SCREENSHOT_BUCKET });
}

export async function storeScreenshot(
  bytes: Uint8Array,
  meta: { userId: string; entryId: string; contentType: ScreenshotType }
): Promise<mongoose.Types.ObjectId> {
  const bucket = screenshotBucket();
  const uploadStream = bucket.openUploadStream(meta.entryId, { metadata: meta });

  return new Promise<mongoose.Types.ObjectId>((resolve, reject) => {
    uploadStream.on('finish', () => {
      resolve(uploadStream.id as mongoose.Types.ObjectId);
    });
    uploadStream.on('error', (err) => {
      reject(err);
    });
    uploadStream.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  });
}

export async function readScreenshot(
  fileId: mongoose.Types.ObjectId | string,
  userId: string
): Promise<{ bytes: Buffer; contentType: ScreenshotType } | null> {
  const bucket = screenshotBucket();
  const objectId =
    typeof fileId === 'string'
      ? mongoose.isValidObjectId(fileId)
        ? new mongoose.Types.ObjectId(fileId)
        : null
      : fileId;

  if (!objectId) {
    return null;
  }

  const files = await bucket.find({ _id: objectId, 'metadata.userId': userId }).toArray();
  const fileDoc = files[0];
  if (!fileDoc) {
    return null;
  }

  const downloadStream = bucket.openDownloadStream(objectId);
  const chunks: Buffer[] = [];

  return new Promise<{ bytes: Buffer; contentType: ScreenshotType }>((resolve, reject) => {
    downloadStream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    downloadStream.on('error', (err) => {
      reject(err);
    });
    downloadStream.on('end', () => {
      const bytes = Buffer.concat(chunks);
      resolve({
        bytes,
        contentType: fileDoc.metadata?.contentType as ScreenshotType,
      });
    });
  });
}

export async function deleteScreenshotFile(
  fileId: mongoose.Types.ObjectId | string
): Promise<void> {
  const bucket = screenshotBucket();
  const objectId =
    typeof fileId === 'string'
      ? mongoose.isValidObjectId(fileId)
        ? new mongoose.Types.ObjectId(fileId)
        : null
      : fileId;

  if (!objectId) {
    return;
  }

  try {
    await bucket.delete(objectId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.toLowerCase().includes('not found') ||
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return;
    }
    throw err;
  }
}
