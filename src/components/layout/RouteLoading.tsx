import { Skeleton } from '@/components/ui/skeleton';

export function RouteLoading() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-4">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-6 w-40" aria-hidden="true" />
      <Skeleton className="h-32 w-full rounded-lg" aria-hidden="true" />
      <Skeleton className="h-64 w-full rounded-lg" aria-hidden="true" />
    </div>
  );
}
