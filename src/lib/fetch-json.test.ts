import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchJson } from './fetch-json';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('fetchJson', () => {
  it('returns parsed JSON on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), { status: 200 })
    );

    const result = await fetchJson<{ data: string }>('/api/test');
    expect(result).toEqual({ data: 'test' });
  });

  it('passes init options to fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 })
    );

    await fetchJson('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    });

    expect(fetchSpy).toHaveBeenCalledWith('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'value' }),
    });
  });

  it('throws error with server error message on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
    );

    await expect(fetchJson('/api/test')).rejects.toThrow('Not found');
  });

  it('throws fallback error when response body is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })
    );

    await expect(fetchJson('/api/test')).rejects.toThrow(
      'Request failed with status 500'
    );
  });

  it('throws fallback error when response JSON has no error field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Something' }), { status: 400 })
    );

    await expect(fetchJson('/api/test')).rejects.toThrow(
      'Request failed with status 400'
    );
  });

  it('works with generic type parameter', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [1, 2, 3] }), { status: 200 })
    );

    const result = await fetchJson<{ items: number[] }>('/api/items');
    expect(result.items).toEqual([1, 2, 3]);
  });
});
