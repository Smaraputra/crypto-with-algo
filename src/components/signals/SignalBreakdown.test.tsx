import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { SignalComponent } from '@/types/signal';

import { SignalBreakdown } from './SignalBreakdown';

const mockComponents: SignalComponent[] = [
  {
    category: 'trend',
    score: 60,
    weight: 0.33,
    weightedScore: 19.8,
    signals: [
      { name: 'EMA Cross', direction: 'bullish', strength: 70, description: 'EMA12 above EMA26' },
      { name: 'SMA Trend', direction: 'bullish', strength: 50, description: 'Golden cross' },
    ],
  },
  {
    category: 'momentum',
    score: -30,
    weight: 0.33,
    weightedScore: -9.9,
    signals: [
      { name: 'RSI', direction: 'bearish', strength: 65, description: 'RSI overbought at 72' },
    ],
  },
  {
    category: 'volume',
    score: 0,
    weight: 0.15,
    weightedScore: 0,
    signals: [
      { name: 'OBV', direction: 'neutral', strength: 10, description: 'OBV flat' },
    ],
  },
];

describe('SignalBreakdown', () => {
  it('renders the breakdown container', () => {
    render(<SignalBreakdown components={mockComponents} />);
    expect(screen.getByTestId('signal-breakdown')).toBeInTheDocument();
  });

  it('renders all category labels', () => {
    render(<SignalBreakdown components={mockComponents} />);
    expect(screen.getByText('Trend')).toBeInTheDocument();
    expect(screen.getByText('Momentum')).toBeInTheDocument();
    expect(screen.getByText('Volume')).toBeInTheDocument();
  });

  it('displays weight percentages', () => {
    render(<SignalBreakdown components={mockComponents} />);
    expect(screen.getAllByText('(33%)')).toHaveLength(2);
    expect(screen.getByText('(15%)')).toBeInTheDocument();
  });

  it('displays weighted score values', () => {
    render(<SignalBreakdown components={mockComponents} />);
    expect(screen.getByText('+19.8')).toBeInTheDocument();
    expect(screen.getByText('-9.9')).toBeInTheDocument();
  });

  it('renders direction badges for signals', () => {
    render(<SignalBreakdown components={mockComponents} />);
    expect(screen.getAllByText('bullish')).toHaveLength(2);
    expect(screen.getByText('bearish')).toBeInTheDocument();
    expect(screen.getByText('neutral')).toBeInTheDocument();
  });

  it('renders indicator names', () => {
    render(<SignalBreakdown components={mockComponents} />);
    expect(screen.getByText('EMA Cross')).toBeInTheDocument();
    expect(screen.getByText('RSI')).toBeInTheDocument();
    expect(screen.getByText('OBV')).toBeInTheDocument();
  });

  it('renders score bars', () => {
    render(<SignalBreakdown components={mockComponents} />);
    const fills = screen.getAllByTestId('score-bar-fill');
    expect(fills.length).toBe(3);
  });

  it('handles empty components', () => {
    render(<SignalBreakdown components={[]} />);
    expect(screen.getByTestId('signal-breakdown')).toBeInTheDocument();
  });

  it('handles components with no signals', () => {
    const emptyComponent: SignalComponent[] = [
      {
        category: 'futures',
        score: 0,
        weight: 0,
        weightedScore: 0,
        signals: [],
      },
    ];
    render(<SignalBreakdown components={emptyComponent} />);
    expect(screen.getByText('Futures')).toBeInTheDocument();
  });
});
