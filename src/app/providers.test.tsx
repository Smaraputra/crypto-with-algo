import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';

vi.mock('next-auth/react', () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="session-provider">{children}</div>
  ),
  useSession: vi.fn(() => ({ data: null, status: 'unauthenticated' })),
}));

import { Providers } from './providers';

function SessionConsumer() {
  const session = useSession();
  return <div data-testid="session-status">{session.status}</div>;
}

function QueryConsumer() {
  const queryClient = useQueryClient();
  return (
    <div data-testid="query-client">
      {queryClient ? 'has-client' : 'no-client'}
    </div>
  );
}

describe('Providers', () => {
  it('renders children', () => {
    render(
      <Providers>
        <div data-testid="child">Hello</div>
      </Providers>
    );
    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('provides session context via SessionProvider', () => {
    render(
      <Providers>
        <SessionConsumer />
      </Providers>
    );
    expect(screen.getByTestId('session-provider')).toBeInTheDocument();
    expect(screen.getByTestId('session-status')).toHaveTextContent(
      'unauthenticated'
    );
  });

  it('provides query client context via QueryClientProvider', () => {
    render(
      <Providers>
        <QueryConsumer />
      </Providers>
    );
    expect(screen.getByTestId('query-client')).toHaveTextContent('has-client');
  });
});
