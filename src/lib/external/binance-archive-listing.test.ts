// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

import { listKeys, listPrefixes, parseS3Listing } from './binance-archive-listing';

function page(opts: {
  prefixes?: string[];
  keys?: string[];
  truncated?: boolean;
  next?: string;
}): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<Name>data.binance.vision</Name><Prefix>data/</Prefix>` +
    `<IsTruncated>${opts.truncated ? 'true' : 'false'}</IsTruncated>` +
    (opts.next ? `<NextMarker>${opts.next}</NextMarker>` : '') +
    (opts.keys ?? []).map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('') +
    (opts.prefixes ?? []).map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('') +
    `</ListBucketResult>`
  );
}

describe('parseS3Listing', () => {
  it('reads prefixes, keys and the explicit NextMarker', () => {
    const parsed = parseS3Listing(page({ prefixes: ['a/', 'b/'], truncated: true, next: 'b/' }));
    expect(parsed).toEqual({ prefixes: ['a/', 'b/'], keys: [], isTruncated: true, nextMarker: 'b/' });
  });

  it('reads the final page', () => {
    const parsed = parseS3Listing(page({ keys: ['k1.zip', 'k1.zip.CHECKSUM'] }));
    expect(parsed).toEqual({
      prefixes: [],
      keys: ['k1.zip', 'k1.zip.CHECKSUM'],
      isTruncated: false,
      nextMarker: null,
    });
  });

  it('falls back to the last key when truncated without NextMarker', () => {
    const parsed = parseS3Listing(page({ keys: ['a', 'b', 'c'], truncated: true }));
    expect(parsed.nextMarker).toBe('c');
  });

  it('falls back to the last prefix when truncated without NextMarker', () => {
    const parsed = parseS3Listing(page({ prefixes: ['x/', 'y/'], truncated: true }));
    expect(parsed.nextMarker).toBe('y/');
  });

  it('handles an empty result', () => {
    const parsed = parseS3Listing(page({}));
    expect(parsed).toEqual({ prefixes: [], keys: [], isTruncated: false, nextMarker: null });
  });

  it('decodes entity-escaped names', () => {
    const parsed = parseS3Listing(
      page({ prefixes: ['A&amp;B/', 'q&quot;&apos;&lt;&gt;/', 'u&#x4E2D;&#20013;/'], truncated: true, next: 'A&amp;B/' })
    );
    expect(parsed.prefixes).toEqual(['A&B/', 'q"\'<>/', 'u中中/']);
    expect(parsed.nextMarker).toBe('A&B/');
  });
});

describe('listing pagination', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('follows markers to the end and honours the base URL override', async () => {
    vi.stubEnv('BINANCE_ARCHIVE_LIST_URL', 'https://list.test/bucket/');
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      const marker = new URL(url).searchParams.get('marker');
      const body = marker
        ? page({ prefixes: ['c/'] })
        : page({ prefixes: ['a/', 'b/'], truncated: true, next: 'b/' });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await listPrefixes('data/', { retryBaseMs: 0 });

    expect(result).toEqual(['a/', 'b/', 'c/']);
    expect(urls).toHaveLength(2);
    expect(urls[0].startsWith('https://list.test/bucket?')).toBe(true);
    const first = new URL(urls[0]).searchParams;
    expect(first.get('delimiter')).toBe('/');
    expect(first.get('prefix')).toBe('data/');
    expect(new URL(urls[1]).searchParams.get('marker')).toBe('b/');
  });

  it('lists keys without a delimiter, advancing on the last key', async () => {
    const markers: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const params = new URL(url).searchParams;
        expect(params.get('delimiter')).toBeNull();
        markers.push(params.get('marker'));
        return new Response(
          params.get('marker') ? page({ keys: ['k3'] }) : page({ keys: ['k1', 'k2'], truncated: true }),
          { status: 200 }
        );
      })
    );
    expect(await listKeys('data/x/', { retryBaseMs: 0 })).toEqual(['k1', 'k2', 'k3']);
    expect(markers).toEqual([null, 'k2']);
  });

  it('retries a 5xx and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(page({ keys: ['k'] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await listKeys('p/', { retryBaseMs: 0 })).toEqual(['k']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listKeys('p/', { retryBaseMs: 0 })).rejects.toThrow(/HTTP 403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after bounded retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listKeys('p/', { retryBaseMs: 0 })).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('refuses a truncated page that cannot advance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page({ truncated: true }), { status: 200 })));
    await expect(listKeys('p/', { retryBaseMs: 0 })).rejects.toThrow(/cannot advance/);
  });
});
