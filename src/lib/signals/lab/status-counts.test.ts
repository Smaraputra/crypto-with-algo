import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LabScore } from '@/lib/models/lab-score';
import { labStatusCounts } from './status-counts';

describe('labStatusCounts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('counts hypotheses correctly when hypotheses have different statuses', async () => {
    const fixedNow = 1700000000000;

    vi.spyOn(LabScore, 'findOne').mockImplementation(((filter: { version: string; hypothesis: string }) => {
      let result: { barClose: number; state?: { crossedAt: number | null } } | null = null;

      if (filter.hypothesis === 'L1-8h') {
        // Validated hypothesis
        result = {
          barClose: fixedNow - 1000000,
          state: { crossedAt: fixedNow - 500000 },
        };
      } else if (filter.hypothesis === 'L2-5m') {
        // Under test hypothesis
        result = {
          barClose: fixedNow - 1000000,
          state: { crossedAt: null },
        };
      }
      // All other hypotheses return null (not started)

      return {
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(result),
        }),
      };
    }) as unknown as typeof LabScore.findOne);

    const counts = await labStatusCounts(fixedNow);

    expect(counts).toEqual({
      underTest: 1,
      validated: 1,
      notStarted: 11,
      hypotheses: 13,
    });
  });

  it('counts all as not_started when no rows exist', async () => {
    vi.spyOn(LabScore, 'findOne').mockImplementation((() => ({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      }),
    })) as unknown as typeof LabScore.findOne);

    const counts = await labStatusCounts(1700000000000);

    expect(counts).toEqual({
      underTest: 0,
      validated: 0,
      notStarted: 13,
      hypotheses: 13,
    });
  });

  it('counts not_shown toward hypotheses only', async () => {
    const fixedNow = 1700000000000;
    // 3 years prior to fixedNow
    const oldBarClose = fixedNow - 3 * 365 * 86400000;

    vi.spyOn(LabScore, 'findOne').mockImplementation(((filter: { version: string; hypothesis: string }) => {
      let result: { barClose: number; state?: { crossedAt: number | null } } | null = null;

      if (filter.hypothesis === 'L1-8h') {
        // Expired test (> 24 months, crossedAt is null -> not_shown)
        result = {
          barClose: oldBarClose,
          state: { crossedAt: null },
        };
      }

      return {
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(result),
        }),
      };
    }) as unknown as typeof LabScore.findOne);

    const counts = await labStatusCounts(fixedNow);

    // L1-8h is not_shown (counts to hypotheses only), remaining 12 are not_started
    expect(counts).toEqual({
      underTest: 0,
      validated: 0,
      notStarted: 12,
      hypotheses: 13,
    });
  });
});
