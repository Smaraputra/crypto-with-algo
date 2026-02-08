import { beforeEach, describe, expect, it } from 'vitest';

import { useUIStore } from './uiStore';

const initialState = {
  sidebarOpen: true,
  mobileSidebarOpen: false,
  selectedSymbol: 'BTCUSDT',
  selectedInterval: '1h',
  chartType: 'candle_solid' as const,
};

describe('uiStore', () => {
  beforeEach(() => {
    useUIStore.setState(initialState);
  });

  describe('initial state', () => {
    it('has sidebarOpen set to true', () => {
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });

    it('has selectedSymbol set to BTCUSDT', () => {
      expect(useUIStore.getState().selectedSymbol).toBe('BTCUSDT');
    });

    it('has selectedInterval set to 1h', () => {
      expect(useUIStore.getState().selectedInterval).toBe('1h');
    });
  });

  describe('setSidebarOpen', () => {
    it('sets sidebarOpen to false', () => {
      useUIStore.getState().setSidebarOpen(false);
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it('sets sidebarOpen to true', () => {
      useUIStore.getState().setSidebarOpen(false);
      useUIStore.getState().setSidebarOpen(true);
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('toggleSidebar', () => {
    it('flips sidebarOpen from true to false', () => {
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it('flips back to original after two toggles', () => {
      useUIStore.getState().toggleSidebar();
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });
  });

  describe('setSelectedSymbol', () => {
    it('updates the selected symbol', () => {
      useUIStore.getState().setSelectedSymbol('ETHUSDT');
      expect(useUIStore.getState().selectedSymbol).toBe('ETHUSDT');
    });
  });

  describe('setSelectedInterval', () => {
    it('updates the selected interval', () => {
      useUIStore.getState().setSelectedInterval('4h');
      expect(useUIStore.getState().selectedInterval).toBe('4h');
    });
  });

  describe('mobileSidebarOpen', () => {
    it('defaults to false', () => {
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('sets mobileSidebarOpen to true', () => {
      useUIStore.getState().setMobileSidebarOpen(true);
      expect(useUIStore.getState().mobileSidebarOpen).toBe(true);
    });

    it('sets mobileSidebarOpen back to false', () => {
      useUIStore.getState().setMobileSidebarOpen(true);
      useUIStore.getState().setMobileSidebarOpen(false);
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('is independent of sidebarOpen', () => {
      useUIStore.getState().setMobileSidebarOpen(true);
      expect(useUIStore.getState().sidebarOpen).toBe(true);
      useUIStore.getState().toggleSidebar();
      expect(useUIStore.getState().mobileSidebarOpen).toBe(true);
    });
  });

  describe('chartType', () => {
    it('defaults to candle_solid', () => {
      expect(useUIStore.getState().chartType).toBe('candle_solid');
    });

    it('sets chart type', () => {
      useUIStore.getState().setChartType('ohlc');
      expect(useUIStore.getState().chartType).toBe('ohlc');
    });

    it('sets chart type to area', () => {
      useUIStore.getState().setChartType('area');
      expect(useUIStore.getState().chartType).toBe('area');
    });
  });

  describe('state isolation', () => {
    it('does not affect other state when setting symbol', () => {
      useUIStore.getState().setSelectedSymbol('ETHUSDT');
      expect(useUIStore.getState().sidebarOpen).toBe(true);
      expect(useUIStore.getState().selectedInterval).toBe('1h');
    });

    it('does not affect other state when setting interval', () => {
      useUIStore.getState().setSelectedInterval('1d');
      expect(useUIStore.getState().sidebarOpen).toBe(true);
      expect(useUIStore.getState().selectedSymbol).toBe('BTCUSDT');
    });
  });
});
