import { describe, expect, it } from 'vitest';
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS_PER_ENTRY,
  SCREENSHOT_BUCKET,
  screenshotBucket,
  sniffImageType,
} from './screenshots';

describe('sniffImageType', () => {
  it('detects PNG from magic bytes', () => {
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    expect(sniffImageType(pngHeader)).toBe('image/png');
  });

  it('detects JPEG from magic bytes', () => {
    const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(sniffImageType(jpegHeader)).toBe('image/jpeg');
  });

  it('detects WebP from RIFF and WEBP magic bytes', () => {
    // RIFF (bytes 0-3), 4 bytes size, WEBP (bytes 8-11)
    const webpHeader = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // 'R', 'I', 'F', 'F'
      0x24, 0x00, 0x00, 0x00, // size
      0x57, 0x45, 0x42, 0x50, // 'W', 'E', 'B', 'P'
      0x56, 0x50, 0x38, 0x20, // 'VP8 '
    ]);
    expect(sniffImageType(webpHeader)).toBe('image/webp');
  });

  it('returns null for a text buffer', () => {
    const textBuffer = new TextEncoder().encode('Hello, this is just plain text content.');
    expect(sniffImageType(textBuffer)).toBeNull();
  });

  it('returns null for a buffer shorter than 12 bytes that is not an image', () => {
    const shortBuffer = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(sniffImageType(shortBuffer)).toBeNull();
  });

  it('returns null for an empty buffer', () => {
    const empty = new Uint8Array([]);
    expect(sniffImageType(empty)).toBeNull();
  });

  it('rejects a GIF header (GIF89a)', () => {
    // GIF89a: 0x47, 0x49, 0x46, 0x38, 0x39, 0x61
    const gifHeader = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00]);
    expect(sniffImageType(gifHeader)).toBeNull();
  });
});

describe('screenshot constants', () => {
  it('exposes expected limits and bucket name', () => {
    expect(SCREENSHOT_BUCKET).toBe('journalScreenshots');
    expect(MAX_SCREENSHOT_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_SCREENSHOTS_PER_ENTRY).toBe(4);
  });
});

describe('screenshotBucket error handling', () => {
  it('throws an error when mongoose connection db is undefined', () => {
    expect(() => screenshotBucket()).toThrow('Database connection is not open');
  });
});
