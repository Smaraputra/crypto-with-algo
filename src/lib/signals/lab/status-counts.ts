import { LabScore } from '@/lib/models/lab-score';
import {
  LAB_HYPOTHESES_V1,
  LAB_HYPOTHESES_V2,
  LAB_HYPOTHESES_V3,
  LAB_HYPOTHESES_V4,
  type LabHypothesis,
} from '@/lib/signals/lab/candidates';
import { initialEState } from '@/lib/signals/lab/e-process';
import { labStatus } from '@/lib/signals/lab/view';

export interface LabStatusCounts {
  underTest: number;
  validated: number;
  notStarted: number;
  hypotheses: number;
}

const ALL_HYPOTHESES: readonly LabHypothesis[] = [
  ...LAB_HYPOTHESES_V1,
  ...LAB_HYPOTHESES_V2,
  ...LAB_HYPOTHESES_V3,
  ...LAB_HYPOTHESES_V4,
];

interface ProjectedLabScore {
  barClose: number;
  state?: {
    crossedAt?: number | null;
  };
}

export async function labStatusCounts(
  now = Date.now()
): Promise<LabStatusCounts> {
  const statuses = await Promise.all(
    ALL_HYPOTHESES.map(async (hyp) => {
      const [latest, first] = await Promise.all([
        LabScore.findOne(
          { version: hyp.version, hypothesis: hyp.id },
          { barClose: 1, 'state.crossedAt': 1 }
        )
          .sort({ barClose: -1 })
          .lean<ProjectedLabScore | null>(),
        LabScore.findOne(
          { version: hyp.version, hypothesis: hyp.id },
          { barClose: 1, 'state.crossedAt': 1 }
        )
          .sort({ barClose: 1 })
          .lean<ProjectedLabScore | null>(),
      ]);

      const state = latest?.state ?? initialEState();
      const firstGradedAt = first?.barClose ?? null;
      return labStatus({
        firstGradedAt,
        crossedAt: state.crossedAt ?? null,
        now,
      });
    })
  );

  let underTest = 0;
  let validated = 0;
  let notStarted = 0;
  let hypotheses = 0;

  for (const status of statuses) {
    hypotheses += 1;
    if (status === 'under_test') {
      underTest += 1;
    } else if (status === 'validated') {
      validated += 1;
    } else if (status === 'not_started') {
      notStarted += 1;
    }
  }

  return {
    underTest,
    validated,
    notStarted,
    hypotheses,
  };
}
