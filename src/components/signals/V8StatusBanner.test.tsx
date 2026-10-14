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

  it('lists the four studies behind the label', () => {
    render(<V8StatusBanner />);
    expect(within(screen.getByTestId('v8-status-banner')).getAllByRole('listitem')).toHaveLength(4);
  });
});
