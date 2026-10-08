import { create } from 'zustand';

import type { FormingBar } from '@/lib/signals/provisional/types';

/**
 * One kline stream message for the bar being formed. Market data only: the
 * provisional score is never put in a store, it lives in component state.
 */
export interface FormingBarEvent {
  /** Uppercase, e.g. BTCUSDT. */
  symbol: string;
  interval: string;
  bar: FormingBar;
  /** True on the final message of the bar (kline `x`). */
  closed: boolean;
  receivedAt: number;
}

interface FormingBarState {
  latest: FormingBarEvent | null;
  push: (event: FormingBarEvent) => void;
  reset: () => void;
}

// Deliberately no persist middleware.
export const useFormingBarStore = create<FormingBarState>((set) => ({
  latest: null,
  push: (event) => set({ latest: event }),
  reset: () => set({ latest: null }),
}));
