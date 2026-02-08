import { create } from 'zustand';

export interface UIState {
  sidebarOpen: boolean;
  mobileSidebarOpen: boolean;
  selectedSymbol: string;
  selectedInterval: string;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setSelectedSymbol: (symbol: string) => void;
  setSelectedInterval: (interval: string) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  mobileSidebarOpen: false,
  selectedSymbol: 'BTCUSDT',
  selectedInterval: '1h',
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
  setSelectedInterval: (interval) => set({ selectedInterval: interval }),
}));
