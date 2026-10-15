/**
 * The container commands scripts/ops/rv-revalidation-run.sh emits after the image ID, one builder per call. One
 * source for both sides of the runner-to-stage seam (final review m7): rv-revalidation-run.test.ts asserts that the
 * runner emits exactly these, and rv-revalidation-cli.test.ts runs each of them through the real CLI. A flag or path
 * changed on either side then fails a test. Paths are the container's: /app/out is rv2-out and /app/ds is rv2-ds.
 */
import type { ShardStage } from '../../research/rv-stages';

const STAGES = ['npx', 'tsx', 'scripts/research/rv-stages.ts'];
const JUDGE = ['npx', 'tsx', 'scripts/research/rv-judge.ts'];

export const RUNNER_ARGV = {
  resolve: (hash: string) => [...STAGES, 'resolve', '--dataset-dir', '/app/ds', '--out-dir', '/app/out/inputs', '--expect-manifest-hash', hash],
  inputs: (hash: string) => [
    ...STAGES, 'inputs', '--dataset-dir', '/app/ds', '--out-dir', '/app/out/inputs', '--resolutions', '/app/out/inputs/resolutions.json',
    '--expect-manifest-hash', hash,
  ],
  real: (hash: string) => [...STAGES, 'real', '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', hash, '--out', '/app/out/part/real.json'],
  shard: (stage: ShardStage, name: string, hash: string) => [
    ...STAGES, 'shard', '--stage', stage, '--name', name, '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', hash,
    '--out', `/app/out/part/${name}.jsonl`,
  ],
  calibrate: (name: string) => [...STAGES, 'calibrate', '--name', name, '--out', `/app/out/part/${name}.json`],
  jobs: (stage: ShardStage | 'calibrate') => [...JUDGE, 'jobs', stage],
  merge: (stage: ShardStage, hash: string) => [
    ...JUDGE, 'merge', '--stage', stage, '--dir', `/app/out/shards/${stage}`, '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', hash,
    '--out', `/app/out/part/${stage}.json`,
  ],
  checkCalibration: () => [...JUDGE, 'check-calibration', '--dir', '/app/out/calibration', '--out', '/app/out/part/calibration.json'],
  dsr: (hash: string) => [...JUDGE, 'dsr', '--real', '/app/out/real.json', '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', hash],
  verdict: (hash: string) => [
    ...JUDGE, 'verdict', '--real', '/app/out/real.json', '--is', '/app/out/is-mcpt.json', '--wf', '/app/out/wf-mcpt.json',
    '--block', '/app/out/block.json', '--shards-dir', '/app/out/shards', '--calibration', '/app/out/calibration.json',
    '--calibration-dir', '/app/out/calibration', '--inputs-dir', '/app/out/inputs', '--expect-manifest-hash', hash,
    '--out', '/app/out/part/verdict.json',
  ],
};

/** The files of rv2-out/inputs the runner checks for by name: resolve writes the first two, inputs the last two. */
export const RUNNER_INPUTS_FILES = { resolve: ['resolutions.json', 'resolve.json'], inputs: ['inputs.json', 'panel.json.gz'] } as const;
