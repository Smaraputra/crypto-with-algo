/**
 * The live scorer's version, stamped on every GlobalSignal and SignalOutcome
 * and read by every consumer that must not pool scores across versions (the
 * calibration dashboard, the trade plan's live record, the paper desk's epoch).
 *
 * One constant rather than a literal at the write site, so a bump cannot leave
 * a reader filtering on the old number. The history of what each version
 * changed is in `compute-engine.ts` beside the write.
 */
export const SCORER_CONFIG_VERSION = 8;
