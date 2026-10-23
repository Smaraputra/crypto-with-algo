import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketFoot } from './MarketFoot';
import { useFearAndGreed } from '@/hooks/useSentiment';
import { useLatestNews } from '@/hooks/useNews';

vi.mock('@/hooks/useSentiment', () => ({
  useFearAndGreed: vi.fn(),
}));
vi.mock('@/hooks/useNews', () => ({
  useLatestNews: vi.fn(),
}));

describe('MarketFoot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders Fear and Greed sentence, up to 5 headlines with external links, and attribution', () => {
    vi.mocked(useFearAndGreed).mockReturnValue({
      data: {
        sentiment: {
          fearGreedIndex: 72,
          label: 'Greed',
        },
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    vi.mocked(useLatestNews).mockReturnValue({
      data: {
        articles: [
          {
            id: '1',
            title: 'Bitcoin breaks new high',
            url: 'https://news.example.com/1',
            source: 'CoinDesk',
            body: '',
            categories: 'BTC',
            publishedOn: Math.floor(Date.now() / 1000) - 300,
            imageUrl: null,
          },
          {
            id: '2',
            title: 'Ethereum layer 2 surge',
            url: 'https://news.example.com/2',
            source: 'CoinTelegraph',
            body: '',
            categories: 'ETH',
            publishedOn: Math.floor(Date.now() / 1000) - 1200,
            imageUrl: null,
          },
          {
            id: '3',
            title: 'Solana network activity increases',
            url: 'https://news.example.com/3',
            source: 'Decrypt',
            body: '',
            categories: 'SOL',
            publishedOn: Math.floor(Date.now() / 1000) - 3600,
            imageUrl: null,
          },
          {
            id: '4',
            title: 'Macro markets update',
            url: 'https://news.example.com/4',
            source: 'Bloomberg',
            body: '',
            categories: 'MACRO',
            publishedOn: Math.floor(Date.now() / 1000) - 7200,
            imageUrl: null,
          },
          {
            id: '5',
            title: 'Crypto regulation outlook',
            url: 'https://news.example.com/5',
            source: 'Reuters',
            body: '',
            categories: 'REG',
            publishedOn: Math.floor(Date.now() / 1000) - 86400,
            imageUrl: null,
          },
          {
            id: '6',
            title: 'Sixth article should be omitted',
            url: 'https://news.example.com/6',
            source: 'Extra',
            body: '',
            categories: 'EXTRA',
            publishedOn: Math.floor(Date.now() / 1000) - 90000,
            imageUrl: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<MarketFoot />);

    expect(screen.getByText('Fear and Greed: 72, Greed.')).toBeInTheDocument();

    expect(screen.getByText('Bitcoin breaks new high')).toBeInTheDocument();
    expect(screen.getByText('Ethereum layer 2 surge')).toBeInTheDocument();
    expect(screen.getByText('Solana network activity increases')).toBeInTheDocument();
    expect(screen.getByText('Macro markets update')).toBeInTheDocument();
    expect(screen.getByText('Crypto regulation outlook')).toBeInTheDocument();
    expect(screen.queryByText('Sixth article should be omitted')).not.toBeInTheDocument();

    const link1 = screen.getByRole('link', { name: /Bitcoin breaks new high/i });
    expect(link1).toHaveAttribute('href', 'https://news.example.com/1');
    expect(link1).toHaveAttribute('target', '_blank');
    expect(link1).toHaveAttribute('rel', 'noopener noreferrer');

    const attribution = screen.getByRole('link', {
      name: 'Market data from Binance',
    });
    expect(attribution).toHaveAttribute('href', 'https://www.binance.com/');
    expect(attribution).toHaveAttribute('target', '_blank');
    expect(attribution).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders headlines error text when headlines fail', () => {
    vi.mocked(useFearAndGreed).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    vi.mocked(useLatestNews).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<MarketFoot />);
    expect(screen.getByText('Headlines did not load.')).toBeInTheDocument();
  });

  it('omits Fear and Greed line on error', () => {
    vi.mocked(useFearAndGreed).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    vi.mocked(useLatestNews).mockReturnValue({
      data: { articles: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<MarketFoot />);
    expect(screen.queryByText(/Fear and Greed:/i)).not.toBeInTheDocument();
  });

  it('decodes HTML entities in headline title and source', () => {
    vi.mocked(useFearAndGreed).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useFearAndGreed>);

    vi.mocked(useLatestNews).mockReturnValue({
      data: {
        articles: [
          {
            id: '1',
            title: 'Bitcoin in &#39;Wait&#39; &amp; see',
            url: 'https://news.example.com/1',
            source: 'CoinDesk &amp; Partners',
            body: '',
            categories: 'BTC',
            publishedOn: Math.floor(Date.now() / 1000) - 300,
            imageUrl: null,
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLatestNews>);

    render(<MarketFoot />);
    expect(screen.getByText("Bitcoin in 'Wait' & see")).toBeInTheDocument();
    expect(screen.getByText(/CoinDesk & Partners/)).toBeInTheDocument();
  });
});
