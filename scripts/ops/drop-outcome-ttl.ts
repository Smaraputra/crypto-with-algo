/**
 * Removes the legacy 365-day TTL index ({ createdAt: 1 } with expireAfterSeconds) from the
 * signaloutcomes collection, so SignalOutcome rows stop expiring. Run it only after the app has
 * been redeployed from the schema that no longer declares the TTL index, because an old app
 * container still on the previous schema recreates the index at start-up (autoIndex is on).
 *
 * Drops ONLY an index whose key is exactly { createdAt: 1 } and that has expireAfterSeconds set.
 * No other index is touched. With no such index it is a no-op.
 *
 * Flags:
 *   --dry-run           print indexes, oldest createdAt, count and group counts, change nothing
 *   --mongo-uri <uri>   override MONGODB_URI before connecting
 */
import mongoose from 'mongoose';

export interface IndexInfo {
  name: string;
  key: Record<string, number | string>;
  expireAfterSeconds: number | null;
}

export interface CollectionSummary {
  total: number;
  oldestCreatedAt: string | null;
  groups: Record<string, Record<string, number>>;
}

export interface DropResult {
  dropped: string | null;
  dryRun: boolean;
  summary: CollectionSummary | null;
}

type OutcomeCollection = mongoose.mongo.Collection;

const GROUP_FIELDS = ['source', 'style', 'tradingStyle', 'interval', 'status'];

async function listIndexes(collection: OutcomeCollection): Promise<IndexInfo[]> {
  const indexes = await collection.indexes();
  return indexes.map((idx) => ({
    name: String(idx.name),
    key: idx.key as Record<string, number | string>,
    expireAfterSeconds: idx.expireAfterSeconds ?? null,
  }));
}

function isCreatedAtTtl(idx: IndexInfo): boolean {
  const keys = Object.keys(idx.key);
  return keys.length === 1 && keys[0] === 'createdAt' && idx.key.createdAt === 1 && idx.expireAfterSeconds !== null;
}

async function summarise(collection: OutcomeCollection): Promise<CollectionSummary> {
  const total = await collection.countDocuments({});
  const oldest = await collection
    .find({ createdAt: { $exists: true } }, { projection: { createdAt: 1 } })
    .sort({ createdAt: 1 })
    .limit(1)
    .toArray();
  const oldestValue = oldest[0]?.createdAt;
  const groups: Record<string, Record<string, number>> = {};
  for (const field of GROUP_FIELDS) {
    const present = await collection.countDocuments({ [field]: { $exists: true } });
    if (present === 0) continue;
    const rows = await collection
      .aggregate<{ _id: unknown; n: number }>([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }])
      .toArray();
    groups[field] = Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
  }
  return {
    total,
    oldestCreatedAt: oldestValue ? new Date(oldestValue).toISOString() : null,
    groups,
  };
}

export async function dropOutcomeTtl(
  collection: OutcomeCollection,
  options: { dryRun: boolean },
  log: (line: unknown) => void = (line) => console.log(JSON.stringify(line))
): Promise<DropResult> {
  const before = await listIndexes(collection);
  log({ kind: 'indexes', phase: 'before', indexes: before });

  if (options.dryRun) {
    const summary = await summarise(collection);
    log({ kind: 'summary', ...summary });
    return { dropped: null, dryRun: true, summary };
  }

  const ttl = before.find(isCreatedAtTtl);
  if (!ttl) {
    log({ kind: 'migration', action: 'drop-outcome-ttl', dropped: null, note: 'no TTL index, nothing to do' });
    return { dropped: null, dryRun: false, summary: null };
  }

  await collection.dropIndex(ttl.name);
  log({ kind: 'migration', action: 'drop-outcome-ttl', dropped: ttl.name });
  log({ kind: 'indexes', phase: 'after', indexes: await listIndexes(collection) });
  return { dropped: ttl.name, dryRun: false, summary: null };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const uriIdx = argv.indexOf('--mongo-uri');
  if (uriIdx !== -1 && argv[uriIdx + 1]) process.env.MONGODB_URI = argv[uriIdx + 1];
  const dryRun = argv.includes('--dry-run');

  const { connectDB } = await import('@/lib/mongodb');
  await connectDB();
  // Raw collection, not the model: importing the model would let autoIndex create declared
  // indexes on connect, which would break the dry run's promise of changing nothing.
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');
  await dropOutcomeTtl(db.collection('signaloutcomes'), { dryRun });
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
