import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useIsClient } from './useIsClient';

function TestComponent() {
  const isClient = useIsClient();
  return <div>{isClient ? 'client' : 'server'}</div>;
}

describe('useIsClient', () => {
  it('gives "server" from renderToString', () => {
    const html = renderToString(<TestComponent />);
    expect(html).toContain('server');
    expect(html).not.toContain('client');
  });

  it('gives "client" from Testing Library render', () => {
    render(<TestComponent />);
    expect(screen.getByText('client')).toBeInTheDocument();
    expect(screen.queryByText('server')).not.toBeInTheDocument();
  });
});
