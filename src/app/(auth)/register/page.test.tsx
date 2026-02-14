import { describe, expect, it, vi } from 'vitest';

const mockRedirect = vi.fn();

vi.mock('next/navigation', () => ({
  redirect: (...args: unknown[]) => mockRedirect(...args),
}));

import RegisterPage from './page';

describe('RegisterPage', () => {
  it('redirects to /login', () => {
    RegisterPage();
    expect(mockRedirect).toHaveBeenCalledWith('/login');
  });
});
