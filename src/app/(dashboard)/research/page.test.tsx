import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/journal/PlaybookView', () => ({
  PlaybookView: () => <div data-testid="playbook-view" />,
}));

import ResearchPage from './page';

describe('ResearchPage', () => {
  it('renders page heading', () => {
    render(<ResearchPage />);
    expect(screen.getByText('Research Notes')).toBeInTheDocument();
  });

  it('renders PlaybookView', () => {
    render(<ResearchPage />);
    expect(screen.getByTestId('playbook-view')).toBeInTheDocument();
  });
});
