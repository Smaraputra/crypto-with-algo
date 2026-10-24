import React from 'react';

export function BlogPage() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-12 px-4 py-12 sm:px-6 sm:py-16">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Blog
        </h1>
        <p className="mt-2 text-base text-ink-2 leading-relaxed">
          Research notes, platform updates, and methodology writeups.
        </p>
      </header>

      <section className="rounded-panel border border-line bg-card p-8 sm:p-12 text-center">
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">
          No posts yet
        </h2>
        <p className="mt-3 text-base text-ink-2 max-w-md mx-auto leading-relaxed">
          Nothing has been published here yet.
        </p>
      </section>
    </div>
  );
}
