'use client';

export function HeroBackground() {
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      aria-hidden="true"
    >
      {/* Central radial gradient glow (green-tinted) */}
      <div
        data-orb
        className="absolute top-1/4 left-1/2 h-[600px] w-[800px] -translate-x-1/2 -translate-y-1/4 rounded-full opacity-[0.08] blur-[120px]"
        style={{ background: 'radial-gradient(ellipse, #0ecb81, transparent)' }}
      />
      {/* Secondary subtle glow */}
      <div
        data-orb
        className="absolute -bottom-32 right-1/4 h-[400px] w-[400px] rounded-full opacity-[0.04] blur-[100px]"
        style={{ background: '#00d4aa' }}
      />
      {/* Dot matrix pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'radial-gradient(circle, oklch(1 0 0 / 0.4) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />
    </div>
  );
}
