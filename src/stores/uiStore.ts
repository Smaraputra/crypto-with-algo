import { create } from 'zustand';

export interface UIState {
  sidebarOpen: boolean;
  selectedSymbol: string;
  selectedInterval: string;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSelectedSymbol: (symbol: string) => void;
  setSelectedInterval: (interval: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  selectedSymbol: 'BTCUSDT',
  selectedInterval: '1h',
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
  setSelectedInterval: (interval) => set({ selectedInterval: interval }),
}));
