import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LegalPage } from './LegalPage';

describe('LegalPage', () => {
  it('renders the title as h1, the last-updated date, and children content', () => {
    render(
      <LegalPage title="Privacy Policy" lastUpdated="March 4, 2026">
        <p>This is privacy policy body text.</p>
      </LegalPage>
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByText('Last updated: March 4, 2026')).toBeInTheDocument();
    expect(screen.getByText('This is privacy policy body text.')).toBeInTheDocument();
  });
});
