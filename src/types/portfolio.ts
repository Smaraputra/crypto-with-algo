export interface Transaction {
  _id?: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  date: Date;
  notes?: string;
  fee?: number;
}

export interface Holding {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  quantity: number;
  avgBuyPrice: number;
  transactions: Transaction[];
}

export interface Portfolio {
  _id: string;
  userId: string;
  name: string;
  holdings: Holding[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioListItem {
  _id: string;
  name: string;
  holdingsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PortfolioResponse {
  portfolio: Portfolio;
}

export interface PortfolioListResponse {
  portfolios: PortfolioListItem[];
}

export interface AddHoldingInput {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  date?: string;
  notes?: string;
  fee?: number;
}

export interface RecordTransactionInput {
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  date?: string;
  notes?: string;
  fee?: number;
}
