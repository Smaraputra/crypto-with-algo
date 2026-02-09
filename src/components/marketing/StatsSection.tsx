const STATS = [
  { value: '24/7', label: 'Real-time monitoring' },
  { value: '100+', label: 'Supported tokens' },
  { value: '6', label: 'Alert types' },
  { value: '3', label: 'Export formats' },
];

export function StatsSection() {
  return (
    <section className="py-16 sm:py-24">
      <div className="mx-auto max-w-4xl px-4">
        <div
          className="grid grid-cols-2 gap-8 sm:grid-cols-4"
          data-testid="stats-grid"
        >
          {STATS.map((stat) => (
            <div key={stat.label} className="text-center">
              <p className="font-mono tabular-nums text-3xl font-bold text-primary sm:text-4xl">
                {stat.value}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{stat.label}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
