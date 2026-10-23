import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AlertsPage, { metadata } from './page';

vi.mock('@/components/alerts-v2', () => ({
  AlertsScreen: () => <div data-testid="alerts-screen">Alerts Screen Mock</div>,
}));

describe('AlertsPage', () => {
  it('has the correct metadata title', () => {
    expect(metadata.title).toBe('Alerts | CryptoWithAlgo');
  });

  it('renders AlertsScreen', () => {
    render(<AlertsPage />);
    expect(screen.getByTestId('alerts-screen')).toBeInTheDocument();
  });
});
