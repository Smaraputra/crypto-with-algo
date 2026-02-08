const STORAGE_PREFIX = 'chart_overlays_';

export interface SerializedOverlay {
  name: string;
  points: Array<Partial<{ dataIndex: number; timestamp: number; value: number }>>;
}

function getKey(symbol: string): string {
  return `${STORAGE_PREFIX}${symbol}`;
}

export function saveOverlays(symbol: string, overlays: SerializedOverlay[]): void {
  try {
    localStorage.setItem(getKey(symbol), JSON.stringify(overlays));
  } catch {
    // Quota exceeded or storage unavailable -- silently ignore
  }
}

export function loadOverlays(symbol: string): SerializedOverlay[] {
  try {
    const raw = localStorage.getItem(getKey(symbol));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is SerializedOverlay =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SerializedOverlay).name === 'string' &&
        Array.isArray((item as SerializedOverlay).points)
    );
  } catch {
    // Corrupt JSON -- remove and return empty
    localStorage.removeItem(getKey(symbol));
    return [];
  }
}

export function clearOverlays(symbol: string): void {
  localStorage.removeItem(getKey(symbol));
}
