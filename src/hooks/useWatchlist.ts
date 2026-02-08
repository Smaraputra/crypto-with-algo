'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

export function useWatchlist() {
  const queryClient = useQueryClient();

  const query = useQuery<{ symbols: string[] }>({
    queryKey: ['watchlist'],
    queryFn: async () => {
      const res = await fetch('/api/watchlist');
      if (!res.ok) throw new Error('Failed to fetch watchlist');
      return res.json();
    },
  });

  const mutation = useMutation({
    mutationFn: async (symbols: string[]) => {
      const res = await fetch('/api/watchlist', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols }),
      });
      if (!res.ok) throw new Error('Failed to update watchlist');
      return res.json();
    },
    onMutate: async (symbols) => {
      await queryClient.cancelQueries({ queryKey: ['watchlist'] });
      const previous = queryClient.getQueryData<{ symbols: string[] }>(['watchlist']);
      queryClient.setQueryData(['watchlist'], { symbols });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['watchlist'], context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });

  const addSymbol = (symbol: string) => {
    const current = query.data?.symbols ?? [];
    if (!current.includes(symbol)) {
      mutation.mutate([...current, symbol]);
    }
  };

  const removeSymbol = (symbol: string) => {
    const current = query.data?.symbols ?? [];
    mutation.mutate(current.filter((s) => s !== symbol));
  };

  return {
    symbols: query.data?.symbols ?? [],
    isLoading: query.isLoading,
    addSymbol,
    removeSymbol,
  };
}
