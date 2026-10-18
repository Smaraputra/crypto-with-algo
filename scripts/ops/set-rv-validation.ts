/**
 * Sets validationStatus and validationRef on the rv-v1 book. The desk never changes these fields after insert.
 *
 * Usage for the 2026-10-15 verdict:
 *   --status rejected --ref "rv-revalidation RESULT 2026-10-15 (PR #95)"
 *
 * Flags:
 *   --status <value>    unvalidated, validated, or rejected (required)
 *   --ref <text>        reference explanation (required for validated and rejected, omitted for unvalidated)
 *   --book <name>       book name (default: rv-v1)
 *   --dry-run           report planned changes, write nothing
 *   --mongo-uri <uri>   override MONGODB_URI before connecting
 */
import mongoose from 'mongoose';

export type RvValidationStatusArg = 'unvalidated' | 'validated' | 'rejected';

export interface SetValidationArgs {
  status: RvValidationStatusArg;
  ref: string | null;
  dryRun: boolean;
  bookName: string; // default 'rv-v1'
}

/** Throws an Error with a clear message on any invalid input. */
export function parseArgs(argv: string[]): SetValidationArgs & { mongoUri: string | null } {
  let status: string | undefined;
  let ref: string | undefined;
  let bookName = 'rv-v1';
  let dryRun = false;
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--status' || arg === '--ref' || arg === '--book' || arg === '--mongo-uri') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      i++;
      if (arg === '--status') status = next;
      else if (arg === '--ref') ref = next;
      else if (arg === '--book') bookName = next;
      else if (arg === '--mongo-uri') mongoUri = next;
    } else {
      // A mistyped --dry-run must stop the script, never fall through to a write
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (status !== 'unvalidated' && status !== 'validated' && status !== 'rejected') {
    throw new Error('status must be one of unvalidated, validated, rejected');
  }

  let finalRef: string | null = null;
  if (status === 'unvalidated') {
    if (ref !== undefined) {
      throw new Error('--ref must be omitted for status unvalidated');
    }
    finalRef = null;
  } else {
    if (ref === undefined || ref.trim() === '') {
      throw new Error(`--ref is required for status ${status}`);
    }
    finalRef = ref.trim();
  }

  return {
    status,
    ref: finalRef,
    dryRun,
    bookName,
    mongoUri,
  };
}

export interface SetValidationResult {
  before: { validationStatus: string; validationRef: string | null };
  after: { validationStatus: string; validationRef: string | null };
  dryRun: boolean;
  changed: boolean;
}

export async function setRvValidation(
  collection: mongoose.mongo.Collection,
  args: SetValidationArgs,
  log: (line: unknown) => void = (line) => console.log(JSON.stringify(line))
): Promise<SetValidationResult> {
  const book = await collection.findOne({ bookName: args.bookName });
  if (!book) {
    throw new Error(`no book named ${args.bookName}`);
  }

  const before = {
    validationStatus: String(book.validationStatus),
    validationRef: (book.validationRef ?? null) as string | null,
  };
  log({
    kind: 'book',
    phase: 'before',
    bookName: args.bookName,
    validationStatus: before.validationStatus,
    validationRef: before.validationRef,
  });

  const changed = before.validationStatus !== args.status || before.validationRef !== args.ref;

  if (args.dryRun) {
    log({
      kind: 'plan',
      bookName: args.bookName,
      set: { validationStatus: args.status, validationRef: args.ref },
      changed,
    });
    return {
      before,
      after: { validationStatus: args.status, validationRef: args.ref },
      dryRun: true,
      changed,
    };
  }

  if (!changed) {
    log({ kind: 'noop', bookName: args.bookName });
    return {
      before,
      after: { validationStatus: before.validationStatus, validationRef: before.validationRef },
      dryRun: false,
      changed: false,
    };
  }

  await collection.updateOne(
    { bookName: args.bookName },
    { $set: { validationStatus: args.status, validationRef: args.ref, updatedAt: new Date() } }
  );

  const reRead = await collection.findOne({ bookName: args.bookName });
  const after = {
    validationStatus: String(reRead?.validationStatus ?? args.status),
    validationRef: (reRead?.validationRef ?? null) as string | null,
  };
  log({
    kind: 'book',
    phase: 'after',
    bookName: args.bookName,
    validationStatus: after.validationStatus,
    validationRef: after.validationRef,
  });

  return {
    before,
    after,
    dryRun: false,
    changed: true,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;

  const { connectDB } = await import('@/lib/mongodb');
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');
  await setRvValidation(db.collection('rvbooks'), args);
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
