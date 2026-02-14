'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, Loader2 } from 'lucide-react';

interface TriggerOptimizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTriggered: (cronRunId: string) => void;
}

export function TriggerOptimizationDialog({
  open,
  onOpenChange,
  onTriggered,
}: TriggerOptimizationDialogProps) {
  const queryClient = useQueryClient();
  const [symbols, setSymbols] = useState('');
  const [months, setMonths] = useState('6');
  const [autoActivate, setAutoActivate] = useState('true');
  const [error, setError] = useState<string | null>(null);

  const triggerMutation = useMutation({
    mutationFn: async (payload: {
      symbols?: string[];
      months: number;
      autoActivate: boolean;
    }) => {
      const res = await fetch('/api/admin/trigger-monthly-optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to trigger optimization');
      }

      return res.json();
    },
    onSuccess: (data) => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['cron-runs'] });
      onTriggered(data.cronRunId);
      onOpenChange(false);
      resetForm();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });

  function resetForm() {
    setSymbols('');
    setMonths('6');
    setAutoActivate('true');
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const parsedSymbols = symbols
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    triggerMutation.mutate({
      symbols: parsedSymbols.length > 0 ? parsedSymbols : undefined,
      months: parseInt(months, 10),
      autoActivate: autoActivate === 'true',
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trigger Monthly Optimization</DialogTitle>
          <DialogDescription>
            Run optimization across all trading styles. Leave symbols empty to auto-fetch top 5 by volume.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="trigger-symbols">Symbols (optional)</Label>
            <Input
              id="trigger-symbols"
              placeholder="BTCUSDT, ETHUSDT, SOLUSDT"
              value={symbols}
              onChange={(e) => setSymbols(e.target.value)}
              disabled={triggerMutation.isPending}
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated. Leave empty to auto-fetch top 5 by volume.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="trigger-months">Historical Data (months)</Label>
            <Select value={months} onValueChange={setMonths} disabled={triggerMutation.isPending}>
              <SelectTrigger id="trigger-months">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {m} {m === 1 ? 'month' : 'months'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="trigger-auto-activate">Auto-Activate Templates</Label>
            <Select
              value={autoActivate}
              onValueChange={setAutoActivate}
              disabled={triggerMutation.isPending}
            >
              <SelectTrigger id="trigger-auto-activate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="true">Yes</SelectItem>
                <SelectItem value="false">No</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Automatically activate improved templates after optimization.
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={triggerMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={triggerMutation.isPending}>
              {triggerMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting...
                </>
              ) : (
                'Start Optimization'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
