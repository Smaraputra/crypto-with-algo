import type { ResearchNote, CreateResearchNoteInput } from '@/types/research-note';

export const mockResearchNotes: ResearchNote[] = [
  {
    _id: 'rn-1',
    userId: 'user-1',
    title: 'BTC breakout strategy',
    content: '## Entry Criteria\n\n- Wait for daily close above resistance\n- RSI > 50\n- Volume above 20-day average',
    category: 'strategy',
    tags: ['breakout', 'btc'],
    relatedSymbols: ['BTCUSDT'],
    isPinned: true,
    createdAt: '2025-01-10T00:00:00.000Z',
    updatedAt: '2025-01-10T00:00:00.000Z',
  },
  {
    _id: 'rn-2',
    userId: 'user-1',
    title: 'Risk management rules',
    content: '1. Never risk more than 2% per trade\n2. Use stop loss always\n3. Scale out in thirds',
    category: 'rule',
    tags: ['risk', 'position-sizing'],
    relatedSymbols: [],
    isPinned: false,
    createdAt: '2025-01-09T00:00:00.000Z',
    updatedAt: '2025-01-09T00:00:00.000Z',
  },
  {
    _id: 'rn-3',
    userId: 'user-1',
    title: 'Market structure observation',
    content: 'ETH/BTC ratio tends to lead altcoin season by 2-3 weeks.',
    category: 'observation',
    tags: ['altcoin', 'eth'],
    relatedSymbols: ['ETHUSDT'],
    isPinned: false,
    createdAt: '2025-01-08T00:00:00.000Z',
    updatedAt: '2025-01-08T00:00:00.000Z',
  },
];

export const mockCreateResearchNoteInput: CreateResearchNoteInput = {
  title: 'New strategy idea',
  content: 'Testing a mean reversion approach on 4h timeframe.',
  category: 'strategy',
  tags: ['mean-reversion'],
  relatedSymbols: ['BTCUSDT', 'ETHUSDT'],
};

export const mockResearchNote: ResearchNote = mockResearchNotes[0];
