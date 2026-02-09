import React from 'react';

export function Text({ children }: { children?: React.ReactNode }) {
  return <mesh>{children}</mesh>;
}

export function Environment() {
  return null;
}

export function OrbitControls() {
  return null;
}

export function Float({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}
