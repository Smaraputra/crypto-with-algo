// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  session: { user: { id: 'user-1' } } as { user: { id: string } } | null,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => mocks.session }));
vi.mock('@/lib/rate-limit', () => ({
  authenticatedLimiter: {},
  rateLimitUser: async () => null,
}));
vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

import { JournalEntry } from '@/lib/models/journal-entry';
import { POST as uploadScreenshot } from './[id]/screenshots/route';
import { GET as getScreenshot, DELETE as deleteScreenshot } from './screenshots/[fileId]/route';
import { DELETE as deleteEntry } from './[id]/route';
import { MAX_SCREENSHOT_BYTES, SCREENSHOT_BUCKET } from '@/lib/journal/screenshots';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  await JournalEntry.init();
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  mocks.session = { user: { id: 'user-1' } };
  await JournalEntry.deleteMany({});
  const db = mongoose.connection.db;
  if (db) {
    try {
      await db.collection(`${SCREENSHOT_BUCKET}.files`).deleteMany({});
      await db.collection(`${SCREENSHOT_BUCKET}.chunks`).deleteMany({});
    } catch {
      // Collections might not exist yet
    }
  }
});

function makeValidPngBytes(): Uint8Array {
  const bytes = new Uint8Array(108);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < 108; i++) {
    bytes[i] = i % 256;
  }
  return bytes;
}

function makeUploadRequest(entryId: string, file: File): NextRequest {
  const formData = new FormData();
  formData.append('file', file);
  return new NextRequest(`http://localhost/api/journal/${entryId}/screenshots`, {
    method: 'POST',
    body: formData,
  });
}

function makeFile(bytes: Uint8Array, name = 'shot.png', type = 'image/png'): File {
  return new File([bytes as unknown as BlobPart], name, { type });
}

async function createTestEntry(userId = 'user-1') {
  return JournalEntry.create({
    userId,
    symbol: 'BTCUSDT',
    interval: '1h',
    signalScore: 50,
    signalTier: 'buy',
    action: 'buy',
    entryPrice: 40000,
  });
}

describe('Journal screenshots API with real MongoDB', () => {
  it('returns 401 without a session', async () => {
    mocks.session = null;
    const entry = await createTestEntry();
    const file = makeFile(makeValidPngBytes(), 'shot.png', 'image/png');
    const req = makeUploadRequest(entry._id.toString(), file);

    const res = await uploadScreenshot(req, {
      params: Promise.resolve({ id: entry._id.toString() }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 for an entry owned by another user', async () => {
    const entry = await createTestEntry('user-2');
    const file = makeFile(makeValidPngBytes(), 'shot.png', 'image/png');
    const req = makeUploadRequest(entry._id.toString(), file);

    const res = await uploadScreenshot(req, {
      params: Promise.resolve({ id: entry._id.toString() }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 415 for text bytes named shot.png with type image/png', async () => {
    const entry = await createTestEntry();
    const textBytes = new TextEncoder().encode('not a real image header');
    const file = makeFile(textBytes, 'shot.png', 'image/png');
    const req = makeUploadRequest(entry._id.toString(), file);

    const res = await uploadScreenshot(req, {
      params: Promise.resolve({ id: entry._id.toString() }),
    });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe('Screenshots must be PNG, JPEG or WebP.');
  });

  it('returns 413 for a file of MAX_SCREENSHOT_BYTES + 1 bytes', async () => {
    const entry = await createTestEntry();
    const oversizedBytes = new Uint8Array(MAX_SCREENSHOT_BYTES + 1);
    oversizedBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const file = makeFile(oversizedBytes, 'shot.png', 'image/png');
    const req = makeUploadRequest(entry._id.toString(), file);

    const res = await uploadScreenshot(req, {
      params: Promise.resolve({ id: entry._id.toString() }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe('Screenshots can be at most 5 MB.');
  });

  it('returns 201 for a valid PNG with correct metadata in response and bucket', async () => {
    const entry = await createTestEntry();
    const pngBytes = makeValidPngBytes();
    const file = makeFile(pngBytes, 'shot.png', 'image/png');
    const req = makeUploadRequest(entry._id.toString(), file);

    const res = await uploadScreenshot(req, {
      params: Promise.resolve({ id: entry._id.toString() }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.entry.screenshots).toHaveLength(1);
    expect(body.entry.screenshots[0].contentType).toBe('image/png');
    expect(body.entry.screenshots[0].size).toBe(pngBytes.byteLength);
    expect(typeof body.entry.screenshots[0].fileId).toBe('string');

    const filesCollection = mongoose.connection.db!.collection(`${SCREENSHOT_BUCKET}.files`);
    const files = await filesCollection.find({}).toArray();
    expect(files).toHaveLength(1);
    expect(files[0].metadata.userId).toBe('user-1');
    expect(files[0]._id.toString()).toBe(body.entry.screenshots[0].fileId);
  });

  it('returns 400 on a fifth upload, keeping only four files in collection', async () => {
    const entry = await createTestEntry();
    const entryId = entry._id.toString();

    for (let i = 0; i < 4; i++) {
      const file = makeFile(makeValidPngBytes(), `shot-${i}.png`, 'image/png');
      const req = makeUploadRequest(entryId, file);
      const res = await uploadScreenshot(req, {
        params: Promise.resolve({ id: entryId }),
      });
      expect(res.status).toBe(201);
    }

    const filesCollection = mongoose.connection.db!.collection(`${SCREENSHOT_BUCKET}.files`);
    expect(await filesCollection.countDocuments()).toBe(4);

    const fifthFile = makeFile(makeValidPngBytes(), 'shot-5.png', 'image/png');
    const fifthReq = makeUploadRequest(entryId, fifthFile);
    const fifthRes = await uploadScreenshot(fifthReq, {
      params: Promise.resolve({ id: entryId }),
    });
    expect(fifthRes.status).toBe(400);
    const body = await fifthRes.json();
    expect(body.error).toBe('An entry holds at most 4 screenshots.');

    expect(await filesCollection.countDocuments()).toBe(4);
  });

  it('GET returns the same bytes, Content-Type, private Cache-Control; returns 404 for another user', async () => {
    const entry = await createTestEntry();
    const entryId = entry._id.toString();
    const pngBytes = makeValidPngBytes();
    const file = makeFile(pngBytes, 'shot.png', 'image/png');
    const uploadRes = await uploadScreenshot(makeUploadRequest(entryId, file), {
      params: Promise.resolve({ id: entryId }),
    });
    expect(uploadRes.status).toBe(201);
    const uploadBody = await uploadRes.json();
    const fileId = uploadBody.entry.screenshots[0].fileId;

    const getReq = new NextRequest(`http://localhost/api/journal/screenshots/${fileId}`);
    const getRes = await getScreenshot(getReq, {
      params: Promise.resolve({ fileId }),
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toBe('image/png');
    expect(getRes.headers.get('Cache-Control')?.startsWith('private')).toBe(true);
    const downloadedBuffer = await getRes.arrayBuffer();
    expect(new Uint8Array(downloadedBuffer)).toEqual(pngBytes);

    // Another user gets 404
    mocks.session = { user: { id: 'user-2' } };
    const otherGetRes = await getScreenshot(getReq, {
      params: Promise.resolve({ fileId }),
    });
    expect(otherGetRes.status).toBe(404);
  });

  it('DELETE removes screenshot from entry and files collection', async () => {
    const entry = await createTestEntry();
    const entryId = entry._id.toString();
    const file = makeFile(makeValidPngBytes(), 'shot.png', 'image/png');
    const uploadRes = await uploadScreenshot(makeUploadRequest(entryId, file), {
      params: Promise.resolve({ id: entryId }),
    });
    const uploadBody = await uploadRes.json();
    const fileId = uploadBody.entry.screenshots[0].fileId;

    const filesCollection = mongoose.connection.db!.collection(`${SCREENSHOT_BUCKET}.files`);
    expect(await filesCollection.countDocuments()).toBe(1);

    const deleteReq = new NextRequest(`http://localhost/api/journal/screenshots/${fileId}`, {
      method: 'DELETE',
    });
    const delRes = await deleteScreenshot(deleteReq, {
      params: Promise.resolve({ fileId }),
    });
    expect(delRes.status).toBe(200);
    const delBody = await delRes.json();
    expect(delBody.entry.screenshots).toHaveLength(0);

    expect(await filesCollection.countDocuments()).toBe(0);

    const updatedEntry = await JournalEntry.findById(entryId);
    expect(updatedEntry?.screenshots).toHaveLength(0);
  });

  it('DELETE /api/journal/[id] removes entry and all of its files', async () => {
    const entry = await createTestEntry();
    const entryId = entry._id.toString();

    for (let i = 0; i < 2; i++) {
      const file = makeFile(makeValidPngBytes(), `shot-${i}.png`, 'image/png');
      const req = makeUploadRequest(entryId, file);
      const res = await uploadScreenshot(req, {
        params: Promise.resolve({ id: entryId }),
      });
      expect(res.status).toBe(201);
    }

    const filesCollection = mongoose.connection.db!.collection(`${SCREENSHOT_BUCKET}.files`);
    expect(await filesCollection.countDocuments()).toBe(2);

    const deleteEntryReq = new NextRequest(`http://localhost/api/journal/${entryId}`, {
      method: 'DELETE',
    });
    const delEntryRes = await deleteEntry(deleteEntryReq, {
      params: Promise.resolve({ id: entryId }),
    });
    expect(delEntryRes.status).toBe(200);

    expect(await filesCollection.countDocuments()).toBe(0);
    expect(await JournalEntry.findById(entryId)).toBeNull();
  });
});
