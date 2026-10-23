import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders an h1 with title text and 26px weight 600 styling', () => {
    render(<PageHeader title="The honest record" />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('The honest record');
    expect(heading).toHaveClass('text-[26px]');
    expect(heading).toHaveClass('font-semibold');
  });

  it('renders optional description with max 62ch and muted styling', () => {
    render(
      <PageHeader
        title="Lab"
        description="Each idea is written down before it runs, then every bet is recorded."
      />
    );
    const desc = screen.getByText(
      'Each idea is written down before it runs, then every bet is recorded.'
    );
    expect(desc).toBeInTheDocument();
    expect(desc).toHaveClass('max-w-[62ch]');
    expect(desc).toHaveClass('text-muted-foreground');
  });

  it('renders the actions slot', () => {
    render(
      <PageHeader
        title="Lab"
        actions={<button type="button">New test</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'New test' })).toBeInTheDocument();
  });
});
