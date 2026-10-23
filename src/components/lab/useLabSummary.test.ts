import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLabSummary } from './useLabSummary';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useSignalLabV3 } from '@/hooks/useSignalLabV3';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';

vi.mock('@/hooks/useSignalLab', () => ({
  useSignalLab: vi.fn(),
}));
vi.mock('@/hooks/useSignalLabV2', () => ({
  useSignalLabV2: vi.fn(),
}));
vi.mock('@/hooks/useSignalLabV3', () => ({
  useSignalLabV3: vi.fn(),
}));
vi.mock('@/hooks/useSignalLabV4', () => ({
  useSignalLabV4: vi.fn(),
}));

describe('useLabSummary', () => {
  const refetch1 = vi.fn();
  const refetch2 = vi.fn();
  const refetch3 = vi.fn();
  const refetch4 = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates hypothesis counts across lab-v1 to lab-v4 and sets rejected to 1', () => {
    vi.mocked(useSignalLab).mockReturnValue({
      data: {
        version: 'lab-v1',
        threshold: 2,
        hypotheses: [
          { id: 'h1', status: 'under_test' },
          { id: 'h2', status: 'validated' },
          { id: 'h3', status: 'not_shown' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: refetch1,
    } as unknown as ReturnType<typeof useSignalLab>);

    vi.mocked(useSignalLabV2).mockReturnValue({
      data: {
        version: 'lab-v2',
        threshold: 2,
        hypotheses: [
          { id: 'h4', status: 'under_test' },
          { id: 'h5', status: 'not_started' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: refetch2,
    } as unknown as ReturnType<typeof useSignalLabV2>);

    vi.mocked(useSignalLabV3).mockReturnValue({
      data: {
        version: 'lab-v3',
        threshold: 2,
        hypotheses: [
          { id: 'h6', status: 'under_test' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: refetch3,
    } as unknown as ReturnType<typeof useSignalLabV3>);

    vi.mocked(useSignalLabV4).mockReturnValue({
      data: {
        version: 'lab-v4',
        threshold: 2,
        hypotheses: [
          { id: 'h7', status: 'validated' },
          { id: 'h8', status: 'under_test' },
        ],
      },
      isLoading: false,
      isError: false,
      refetch: refetch4,
    } as unknown as ReturnType<typeof useSignalLabV4>);

    const { result } = renderHook(() => useLabSummary());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.counts).toEqual({
      underTest: 4,
      rejected: 1,
      validated: 2,
      notStarted: 1,
    });
  });

  it('reports isLoading true if any lab hook is loading', () => {
    vi.mocked(useSignalLab).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: refetch1,
    } as unknown as ReturnType<typeof useSignalLab>);
    vi.mocked(useSignalLabV2).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: refetch2,
    } as unknown as ReturnType<typeof useSignalLabV2>);
    vi.mocked(useSignalLabV3).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: refetch3,
    } as unknown as ReturnType<typeof useSignalLabV3>);
    vi.mocked(useSignalLabV4).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: refetch4,
    } as unknown as ReturnType<typeof useSignalLabV4>);

    const { result } = renderHook(() => useLabSummary());
    expect(result.current.isLoading).toBe(true);
  });

  it('reports isError and refetches failed hooks via refetchFailed', () => {
    vi.mocked(useSignalLab).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetch1,
    } as unknown as ReturnType<typeof useSignalLab>);
    vi.mocked(useSignalLabV2).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: refetch2,
    } as unknown as ReturnType<typeof useSignalLabV2>);
    vi.mocked(useSignalLabV3).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: refetch3,
    } as unknown as ReturnType<typeof useSignalLabV3>);
    vi.mocked(useSignalLabV4).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: refetch4,
    } as unknown as ReturnType<typeof useSignalLabV4>);

    const { result } = renderHook(() => useLabSummary());
    expect(result.current.isError).toBe(true);

    result.current.refetchFailed();
    expect(refetch1).toHaveBeenCalledTimes(1);
    expect(refetch2).not.toHaveBeenCalled();
    expect(refetch3).toHaveBeenCalledTimes(1);
    expect(refetch4).not.toHaveBeenCalled();
  });
});
