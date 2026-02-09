import React from 'react';

export function Canvas({ children }: { children?: React.ReactNode }) {
  return <div data-testid="r3f-canvas">{children}</div>;
}

export function useFrame() {}

export function useThree() {
  return { gl: {}, scene: {}, camera: {} };
}
