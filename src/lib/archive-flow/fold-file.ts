import {
  streamArchiveCsvLines,
  type ArchiveFileSpec,
  type StreamArchiveOptions,
} from '@/lib/external/binance-archive';
import { parseAggTradeLine } from './agg-trades';
import { FlowFolder, type FlowBucket } from './fold';

export type FoldFileResult =
  | { status: 'missing' }
  | {
      status: 'ok';
      buckets: FlowBucket[];
      lines: number;
      rows: number;
      outOfOrder: number;
      uncompressedBytes: number;
    };

/**
 * Streams one aggTrades archive file and folds it into 5-minute buckets. Raw
 * rows are never kept. A restart after a mid-stream failure discards the
 * partial fold, so a retried file is never counted twice.
 */
export async function foldArchiveFile(
  spec: ArchiveFileSpec,
  options: Omit<StreamArchiveOptions, 'onRestart'> = {}
): Promise<FoldFileResult> {
  let folder = new FlowFolder();
  let buckets: FlowBucket[] = [];

  const result = await streamArchiveCsvLines(
    spec,
    (line) => {
      const trade = parseAggTradeLine(line);
      if (trade) buckets.push(...folder.add(trade));
    },
    {
      ...options,
      onRestart: () => {
        folder = new FlowFolder();
        buckets = [];
      },
    }
  );
  if (result.status === 'missing') return { status: 'missing' };

  buckets.push(...folder.flush());
  return {
    status: 'ok',
    buckets,
    lines: result.lines,
    rows: folder.rows,
    outOfOrder: folder.outOfOrder,
    uncompressedBytes: result.uncompressedBytes,
  };
}
