'use client';

import { useCallback, useRef, useEffect, useState } from 'react';

export function useChartResize(
  chartRef: React.MutableRefObject<{ resize?: () => void } | null>,
  debounceMs = 100
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleResize = useCallback(() => {
    if (!containerRef.current) return;
    const { width, height } = containerRef.current.getBoundingClientRect();
    if (width > 0 && height > 0) {
      setDimensions({ width, height });
      chartRef.current?.resize?.();
    }
  }, [chartRef]);

  useEffect(() => {
    if (!containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(handleResize, debounceMs);
    });

    observer.observe(containerRef.current);
    handleResize();

    return () => {
      observer.disconnect();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [handleResize, debounceMs]);

  return { containerRef, width: dimensions.width, height: dimensions.height };
}
