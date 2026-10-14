import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { V8StatusBanner } from './V8StatusBanner';

describe('V8StatusBanner', () => {
  it('states the label, the sentence and links to the track record', () => {
    render(<V8StatusBanner />);
    const banner = screen.getByTestId('v8-status-banner');

    expect(within(banner).getByText('Measured: no edge')).toBeInTheDocument();
    expect(banner).toHaveTextContent(
      'v8 calls have been measured four ways and none beats chance after costs. They are kept as a record, not as advice.'
    );
    expect(within(banner).getByRole('link', { name: /track record/i })).toHaveAttribute(
      'href',
      '/dashboard#track-record'
    );
  });

  it('renders a one-line compact form with the label and the link only', () => {
    render(<V8StatusBanner compact />);
    const note = screen.getByTestId('v8-status-banner');

    expect(note).toHaveTextContent('Measured: no edge');
    expect(within(note).getByRole('link', { name: /track record/i })).toHaveAttribute(
      'href',
      '/dashboard#track-record'
    );
    expect(within(note).queryAllByRole('listitem')).toHaveLength(0);
    expect(note).not.toHaveTextContent('kept as a record');
  });

  it('lists the four studies behind the label', () => {
    render(<V8StatusBanner />);
    expect(within(screen.getByTestId('v8-status-banner')).getAllByRole('listitem')).toHaveLength(4);
  });
});
