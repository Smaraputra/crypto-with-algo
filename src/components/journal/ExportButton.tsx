'use client';

import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useJournalEntries } from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

function escapeField(value: string | number | null | undefined): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildJournalCsv(entries: JournalEntry[]): string {
  const header =
    'Date,Symbol,Interval,Action,Signal Score,Signal Tier,Entry Price,Exit Price,P&L %,Setup Type,Market Condition,Tags,Notes,Reviewed';
  const rows = entries.map((e) =>
    [
      escapeField(new Date(e.createdAt).toISOString().split('T')[0]),
      escapeField(e.symbol),
      escapeField(e.interval),
      escapeField(e.action),
      escapeField(Math.round(e.signalScore)),
      escapeField(e.signalTier),
      e.entryPrice != null ? escapeField(e.entryPrice) : '',
      e.exitPrice != null ? escapeField(e.exitPrice) : '',
      e.outcomePnlPercent != null ? escapeField(e.outcomePnlPercent.toFixed(2)) : '',
      escapeField(e.setupType),
      escapeField(e.marketCondition),
      escapeField(e.tags.join('; ')),
      escapeField(e.notes),
      e.reviewedAt != null ? 'Yes' : 'No',
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportButton() {
  const { data, isLoading } = useJournalEntries({ limit: 1000 });
  const entries = data?.entries ?? [];

  function handleExport() {
    if (entries.length === 0) return;
    const csv = buildJournalCsv(entries);
    const date = new Date().toISOString().split('T')[0];
    downloadCsv(csv, `journal-export-${date}.csv`);
  }

  return (
    <Button
      variant="outline"
      size="xs"
      onClick={handleExport}
      disabled={isLoading || entries.length === 0}
      data-testid="export-csv-button"
    >
      <Download className="size-3" />
      Export CSV
    </Button>
  );
}
