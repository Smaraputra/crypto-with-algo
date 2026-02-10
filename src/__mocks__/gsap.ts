import { vi } from 'vitest';

const scrollTriggerInstances: Array<{ kill: ReturnType<typeof vi.fn> }> = [];

export const gsap = {
  from: vi.fn(),
  to: vi.fn(),
  set: vi.fn(),
  timeline: vi.fn(() => ({
    to: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    add: vi.fn().mockReturnThis(),
  })),
  registerPlugin: vi.fn(),
  ticker: {
    add: vi.fn(),
    remove: vi.fn(),
    lagSmoothing: vi.fn(),
  },
};

export const ScrollTrigger = {
  getAll: vi.fn(() => scrollTriggerInstances),
  update: vi.fn(),
  create: vi.fn(),
};

export const TextPlugin = {};
