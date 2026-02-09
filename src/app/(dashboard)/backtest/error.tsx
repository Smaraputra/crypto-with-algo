'use client';

import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function BacktestError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Card className="w-full max-w-md border-destructive/50">
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <AlertTriangle className="size-10 text-destructive" />
          <div className="space-y-1">
            <p className="text-lg font-semibold text-foreground">
              Something went wrong
            </p>
            <p className="text-sm text-muted-foreground">
              An unexpected error occurred. Please try again.
            </p>
          </div>
          <Button variant="outline" onClick={reset}>
            Try Again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
