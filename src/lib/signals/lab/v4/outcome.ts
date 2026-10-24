import { LAB_V4_ROUND_TRIP } from '@/lib/signals/lab/candidates';

export type LabV4OutcomeType = 'won' | 'cost' | 'wrong';

export interface LabV4OutcomeResult {
  move: number;
  outcome: LabV4OutcomeType;
}

export function labV4Outcome(side: 1 | -1, start: number, end: number): LabV4OutcomeResult {
  const move = (end - start) / start;
  const d = side * move;

  let outcome: LabV4OutcomeType;
  if (d > LAB_V4_ROUND_TRIP) {
    outcome = 'won';
  } else if (d > 0) {
    outcome = 'cost';
  } else {
    outcome = 'wrong';
  }

  return { move, outcome };
}
