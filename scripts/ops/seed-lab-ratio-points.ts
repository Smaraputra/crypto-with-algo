/**
 * Seeds the labratiopoints collection from a top-trader ratio snapshot JSON file.
 *
 * Snapshot shape:
 * {
 *   fetchedAt: string (ISO),
 *   period: '4h',
 *   points: {
 *     [symbol: string]: Array<{
 *       timestamp: number;
 *       longShortRatio: number;
 *       longAccount?: number;
 *       shortAccount?: number;
 *     }>;
 *   }
 * }
 *
 * Usage:
 *   npx tsx scripts/ops/seed-lab-ratio-points.ts --file <path-to-snapshot.json>
 *
 * Flags:
 *   --file <path>       snapshot JSON file to read (required)
 *   --mongo-uri <uri>   override MONGODB_URI before connecting
 */
import fs from 'node:fs';
import { storeRatioPoints } from '@/lib/models/lab-ratio-point';

export interface SeedArgs {
  file: string;
  mongoUri: string | null;
}

export function parseArgs(argv: string[]): SeedArgs {
  let file: string | undefined;
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--file' || arg === '--mongo-uri') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      i++;
      if (arg === '--file') file = next;
      else if (arg === '--mongo-uri') mongoUri = next;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (!file) {
    throw new Error('--file is required');
  }

  return { file, mongoUri };
}

export interface RatioSnapshotPoint {
  timestamp: number;
  longShortRatio: number;
  longAccount?: number;
  shortAccount?: number;
}

export interface RatioSnapshotData {
  fetchedAt: string;
  period: '4h';
  points: Record<string, RatioSnapshotPoint[]>;
}

export interface SeedSymbolResult {
  symbol: string;
  inserted: number;
  alreadyPresent: number;
}

export async function seedLabRatioPoints(
  filePath: string,
  log: (line: string) => void = console.log
): Promise<SeedSymbolResult[]> {
  const content = await fs.promises.readFile(filePath, 'utf8');
  const data = JSON.parse(content) as RatioSnapshotData;

  if (!data.fetchedAt) {
    throw new Error('snapshot missing fetchedAt');
  }
  if (data.period !== '4h') {
    throw new Error(`unsupported period ${data.period}, expected 4h`);
  }
  if (!data.points || typeof data.points !== 'object') {
    throw new Error('snapshot missing points object');
  }

  const fetchedAt = new Date(data.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) {
    throw new Error(`invalid fetchedAt date: ${data.fetchedAt}`);
  }

  const results: SeedSymbolResult[] = [];

  for (const [symbol, rawPoints] of Object.entries(data.points)) {
    const points = rawPoints.map((p) => ({
      timestamp: p.timestamp,
      longShortRatio: p.longShortRatio,
    }));

    const inserted = await storeRatioPoints(symbol, data.period, points, fetchedAt);
    const alreadyPresent = points.length - inserted;

    results.push({ symbol, inserted, alreadyPresent });
    log(`${symbol}: ${inserted} inserted, ${alreadyPresent} already present`);
  }

  return results;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;

  const { connectDB } = await import('@/lib/mongodb');
  await connectDB();

  await seedLabRatioPoints(args.file);
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    });
}
