/**
 * Wire types for GET /api/admin/calibration.
 *
 * Kept beside the other shared types rather than inferred from the route so the
 * client and the route are checked against one declaration. Every estimate is
 * nullable on purpose: a withheld estimate is a first-class outcome here, not
 * an error, and a non-nullable number would force the route to invent a zero
 * for a sample too small to support one.
 */
import type { SignalTier } from '@/types/signal';
import type { TradingStyle } from '@/lib/models/signal-template';

export type EstimateWithheldReason = 'none' | 'too-few-samples' | 'too-few-blocks';

export interface CalibrationMeta {
  style: TradingStyle;
  interval: string;
  source: 'composite' | 'llm';
  symbol: string | null;
  configVersion: number | null;
  horizonBars: number;
  costPercentRoundTrip: number;
  costIsDefault: boolean;
  rowCount: number;
  bootstrapIterations: number;
  meanBlockLenBars: number;
  minSamplesForEstimate: number;
  minBlocksForCi: number;
  overlapping: boolean;
  statusCounts: { pending: number; resolved: number; unresolvable: number };
  resolvedFrom: number | null;
  resolvedTo: number | null;
  configVersions: number[];
}

export interface TierCalibrationRow {
  tier: SignalTier;
  count: number;
  meanPercent: number | null;
  ciLowPercent: number | null;
  ciHighPercent: number | null;
  netMeanPercent: number | null;
  netCiLowPercent: number | null;
  netCiHighPercent: number | null;
  winRate: number | null;
  avgMfePercent: number | null;
  avgMaePercent: number | null;
  withheld: EstimateWithheldReason;
}

export interface ReliabilityPoint {
  scoreLow: number;
  scoreHigh: number;
  scoreMid: number;
  count: number;
  meanPercent: number | null;
  ciLowPercent: number | null;
  ciHighPercent: number | null;
  withheld: EstimateWithheldReason;
}

export interface DistributionBinRow {
  low: number;
  high: number;
  counts: Record<string, number>;
}

export interface DistributionResponse {
  binEdges: number[];
  bins: DistributionBinRow[];
  tiers: SignalTier[];
  clipped: Record<string, number>;
}

export interface CumulativeSeriesRow {
  configVersion: number;
  count: number;
  points: { candleTimestamp: number; cumulativePercent: number; count: number }[];
}

export interface CalibrationResponse {
  meta: CalibrationMeta;
  tiers: TierCalibrationRow[];
  reliability: ReliabilityPoint[];
  distribution: DistributionResponse;
  cumulative: CumulativeSeriesRow[];
}
