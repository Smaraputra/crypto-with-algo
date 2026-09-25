/**
 * Test helper: give Recharts a size in jsdom.
 *
 * ResponsiveContainer measures its parent through ResizeObserver, which jsdom
 * does not implement, so in a test every chart inside one renders to nothing
 * and an assertion about the chart silently passes against an empty DOM. This
 * replaces the container with a fixed-size wrapper that hands its child an
 * explicit width and height, so the real chart components still run and the
 * SVG under test is the one the app renders.
 *
 * Only ResponsiveContainer is replaced. Mocking the chart components themselves
 * would leave the tests asserting against the mock.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

export const CHART_TEST_WIDTH = 600;
export const CHART_TEST_HEIGHT = 300;

function SizedContainer({ children }: { children?: ReactNode }) {
  return (
    <div data-testid="responsive-container">
      {isValidElement(children)
        ? cloneElement(children as ReactElement<{ width?: number; height?: number }>, {
            width: CHART_TEST_WIDTH,
            height: CHART_TEST_HEIGHT,
          })
        : children}
    </div>
  );
}

/**
 * Factory for `vi.mock('recharts', ...)`. Keeps every real export and swaps only
 * the container:
 *
 *   vi.mock('recharts', async (importOriginal) =>
 *     rechartsWithSizedContainer(await importOriginal()));
 */
export function rechartsWithSizedContainer(actual: Record<string, unknown>) {
  return { ...actual, ResponsiveContainer: SizedContainer };
}
