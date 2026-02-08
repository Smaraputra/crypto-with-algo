import { create } from 'zustand';
import type { CandleType } from 'klinecharts';

export interface UIState {
  sidebarOpen: boolean;
  mobileSidebarOpen: boolean;
  selectedSymbol: string;
  selectedInterval: string;
  chartType: CandleType;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setSelectedSymbol: (symbol: string) => void;
  setSelectedInterval: (interval: string) => void;
  setChartType: (type: CandleType) => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  mobileSidebarOpen: false,
  selectedSymbol: 'BTCUSDT',
  selectedInterval: '1h',
  chartType: 'candle_solid',
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
  setSelectedSymbol: (symbol) => set({ selectedSymbol: symbol }),
  setSelectedInterval: (interval) => set({ selectedInterval: interval }),
  setChartType: (type) => set({ chartType: type }),
}));
