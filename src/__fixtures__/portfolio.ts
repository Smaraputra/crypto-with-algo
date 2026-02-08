import type { Portfolio, PortfolioListItem, Transaction, Holding } from '@/types/portfolio';

export const mockTransaction: Transaction = {
  _id: 'tx-1',
  type: 'buy',
  quantity: 0.5,
  price: 40000,
  date: new Date('2024-01-15'),
  notes: 'Initial BTC purchase',
  fee: 10,
};

export const mockSellTransaction: Transaction = {
  _id: 'tx-2',
  type: 'sell',
  quantity: 0.1,
  price: 45000,
  date: new Date('2024-02-01'),
  fee: 5,
};

export const mockHolding: Holding = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  quantity: 0.5,
  avgBuyPrice: 40020,
  transactions: [mockTransaction],
};

export const mockEthHolding: Holding = {
  symbol: 'ETHUSDT',
  baseAsset: 'ETH',
  quoteAsset: 'USDT',
  quantity: 2.0,
  avgBuyPrice: 2500,
  transactions: [
    {
      _id: 'tx-3',
      type: 'buy',
      quantity: 2.0,
      price: 2500,
      date: new Date('2024-01-20'),
      fee: 5,
    },
  ],
};

export const mockPortfolio: Portfolio = {
  _id: 'portfolio-1',
  userId: 'user-1',
  name: 'My Portfolio',
  holdings: [mockHolding, mockEthHolding],
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-02-01'),
};

export const mockEmptyPortfolio: Portfolio = {
  _id: 'portfolio-2',
  userId: 'user-1',
  name: 'Trading',
  holdings: [],
  createdAt: new Date('2024-01-10'),
  updatedAt: new Date('2024-01-10'),
};

export const mockPortfolioList: PortfolioListItem[] = [
  {
    _id: 'portfolio-1',
    name: 'My Portfolio',
    holdingsCount: 2,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-02-01'),
  },
  {
    _id: 'portfolio-2',
    name: 'Trading',
    holdingsCount: 0,
    createdAt: new Date('2024-01-10'),
    updatedAt: new Date('2024-01-10'),
  },
];
