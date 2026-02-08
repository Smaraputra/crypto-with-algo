import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveOverlays, loadOverlays, clearOverlays, type SerializedOverlay } from './chart-storage';

const mockStorage = new Map<string, string>();

beforeEach(() => {
  mockStorage.clear();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      mockStorage.delete(key);
    }),
  });
});

const overlays: SerializedOverlay[] = [
  { name: 'segment', points: [{ timestamp: 1000, value: 50 }, { timestamp: 2000, value: 60 }] },
  { name: 'horizontalStraightLine', points: [{ timestamp: 1500, value: 55 }] },
];

describe('saveOverlays', () => {
  it('saves overlays to localStorage keyed by symbol', () => {
    saveOverlays('BTCUSDT', overlays);

    const stored = mockStorage.get('chart_overlays_BTCUSDT');
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!)).toEqual(overlays);
  });

  it('overwrites existing overlays for the same symbol', () => {
    saveOverlays('BTCUSDT', overlays);
    const newOverlays = [{ name: 'rayLine', points: [{ timestamp: 3000, value: 70 }] }];
    saveOverlays('BTCUSDT', newOverlays);

    const stored = JSON.parse(mockStorage.get('chart_overlays_BTCUSDT')!);
    expect(stored).toEqual(newOverlays);
  });

  it('handles quota exceeded error silently', () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    expect(() => saveOverlays('BTCUSDT', overlays)).not.toThrow();
  });
});

describe('loadOverlays', () => {
  it('returns overlays from localStorage', () => {
    mockStorage.set('chart_overlays_ETHUSDT', JSON.stringify(overlays));

    const result = loadOverlays('ETHUSDT');
    expect(result).toEqual(overlays);
  });

  it('returns empty array when no data exists', () => {
    expect(loadOverlays('UNKNOWN')).toEqual([]);
  });

  it('returns empty array and removes corrupt JSON', () => {
    mockStorage.set('chart_overlays_BTCUSDT', '{invalid json');

    const result = loadOverlays('BTCUSDT');
    expect(result).toEqual([]);
    expect(localStorage.removeItem).toHaveBeenCalledWith('chart_overlays_BTCUSDT');
  });

  it('filters out invalid overlay entries', () => {
    mockStorage.set(
      'chart_overlays_BTCUSDT',
      JSON.stringify([
        { name: 'segment', points: [{ timestamp: 1000, value: 50 }] },
        { name: 123, points: [] }, // invalid: name is not string
        'not an object',
        null,
        { name: 'rayLine' }, // invalid: no points array
      ])
    );

    const result = loadOverlays('BTCUSDT');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('segment');
  });

  it('returns empty array when stored value is not an array', () => {
    mockStorage.set('chart_overlays_BTCUSDT', JSON.stringify({ not: 'array' }));

    const result = loadOverlays('BTCUSDT');
    expect(result).toEqual([]);
  });
});

describe('clearOverlays', () => {
  it('removes overlays from localStorage', () => {
    mockStorage.set('chart_overlays_BTCUSDT', JSON.stringify(overlays));

    clearOverlays('BTCUSDT');

    expect(localStorage.removeItem).toHaveBeenCalledWith('chart_overlays_BTCUSDT');
    expect(mockStorage.has('chart_overlays_BTCUSDT')).toBe(false);
  });

  it('does not throw when key does not exist', () => {
    expect(() => clearOverlays('NONEXISTENT')).not.toThrow();
  });
});
