import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@react-three/fiber', async () => await import('@/__mocks__/@react-three/fiber'));

import CoinScene from './CoinScene';

describe('CoinScene', () => {
  it('renders the canvas container', () => {
    render(<CoinScene />);
    expect(screen.getByTestId('r3f-canvas')).toBeInTheDocument();
  });
});
