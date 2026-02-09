import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@react-three/fiber', async () => await import('@/__mocks__/@react-three/fiber'));

import GlobeScene from './GlobeScene';

describe('GlobeScene', () => {
  it('renders the canvas container', () => {
    render(<GlobeScene />);
    expect(screen.getByTestId('r3f-canvas')).toBeInTheDocument();
  });
});
