import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CostCheckPage, { metadata } from './page';

vi.mock('@/components/cost-check-v2/CostCheckClient', () => ({
  CostCheckClient: () => <div data-testid="cost-check-client" />,
}));

describe('CostCheckPage', () => {
  it('exports metadata with title Cost Check | CryptoWithAlgo', () => {
    expect(metadata.title).toBe('Cost Check | CryptoWithAlgo');
  });

  it('renders CostCheckClient', () => {
    render(<CostCheckPage />);
    expect(screen.getByTestId('cost-check-client')).toBeInTheDocument();
  });
});
