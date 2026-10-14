import mongoose, { Schema, type Document } from 'mongoose';

import type { RvTrackState } from '@/lib/signals/cross-sectional/engine';

export const RV_BOOK_NAME = 'rv-v1';

export type RvValidationStatus = 'unvalidated' | 'validated' | 'rejected';

/** Maker-track fill outcomes for one bucket of steps. */
export interface RvFillBucket {
  /** Orders that filled at the reference price inside the first hour. */
  makerFilled: number;
  /** Orders that did not, and were filled as takers at the hour's close. */
  makerFallback: number;
  /** Completed steps counted into this bucket. */
  steps: number;
}

export type RvFillBucketKey = '00' | '08' | '16' | 'weekday' | 'weekend';
export type RvFillStats = Record<RvFillBucketKey, RvFillBucket>;

/** Descriptive flags only: none of them ever stops the desk trading. */
export interface RvAlerts {
  /** The taker track's equity is 15% or more below its peak. */
  drawdownTaker: boolean;
  /** The maker track's equity is 15% or more below its peak. */
  drawdownMaker: boolean;
  /** Consecutive steps whose taker equity ended below the previous step's. */
  negativeStreak: number;
}

/**
 * Everything the desk carries from one step to the next. Each RvStep stores
 * the state after it, so a run restores from the step at the cursor and a
 * replay recomputes identical steps.
 */
export interface RvBookState {
  tracks: { taker: RvTrackState; maker: RvTrackState };
  /** Marked equity after the latest step, per track. */
  equity: { taker: number; maker: number };
  peakEquity: { taker: number; maker: number };
  alerts: RvAlerts;
  fillStats: RvFillStats;
}

/**
 * The rv-v1 paper book: one document, a forward record of the frozen rule on
 * two cost tracks (taker, and maker with taker fallback).
 *
 * `lastStepBarTime` is the cursor: the barTime of the newest signal stepped.
 * `leaseUntil` and `leaseOwner` make a run exclusive, taken atomically with
 * one findOneAndUpdate. The book's state fields are a projection of the
 * RvStep at the cursor, written in the same update that clears the lease.
 *
 * `validationStatus` is set by the re-validation verdict, never by the desk.
 */
export interface IRvBook extends Document, RvBookState {
  bookName: string;
  version: 'rv-v1';
  validationStatus: RvValidationStatus;
  /** Where the validation verdict is recorded, null until there is one. */
  validationRef: string | null;
  startedAt: Date;
  /** barTime of the first signal the book stepped, null before that. */
  startBarTime: number | null;
  lastStepBarTime: number | null;
  leaseUntil: Date | null;
  leaseOwner: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const bucketSchema = new Schema(
  {
    makerFilled: { type: Number, required: true, default: 0 },
    makerFallback: { type: Number, required: true, default: 0 },
    steps: { type: Number, required: true, default: 0 },
  },
  { _id: false }
);

const rvBookSchema = new Schema<IRvBook>(
  {
    bookName: { type: String, required: true },
    version: { type: String, enum: ['rv-v1'], required: true },
    validationStatus: {
      type: String,
      enum: ['unvalidated', 'validated', 'rejected'],
      required: true,
      default: 'unvalidated',
    },
    validationRef: { type: String, default: null },
    startedAt: { type: Date, required: true },
    startBarTime: { type: Number, default: null },
    lastStepBarTime: { type: Number, default: null },
    leaseUntil: { type: Date, default: null },
    leaseOwner: { type: String, default: null },
    tracks: {
      taker: { type: Schema.Types.Mixed },
      maker: { type: Schema.Types.Mixed },
    },
    equity: {
      taker: { type: Number },
      maker: { type: Number },
    },
    peakEquity: {
      taker: { type: Number },
      maker: { type: Number },
    },
    alerts: {
      drawdownTaker: { type: Boolean, default: false },
      drawdownMaker: { type: Boolean, default: false },
      negativeStreak: { type: Number, default: 0 },
    },
    fillStats: {
      '00': { type: bucketSchema, default: () => ({}) },
      '08': { type: bucketSchema, default: () => ({}) },
      '16': { type: bucketSchema, default: () => ({}) },
      weekday: { type: bucketSchema, default: () => ({}) },
      weekend: { type: bucketSchema, default: () => ({}) },
    },
  },
  { timestamps: true, minimize: false }
);

// The only index: one book per name, and the desk upserts on it.
rvBookSchema.index({ bookName: 1 }, { unique: true });

export const RvBook =
  (mongoose.models.RvBook as mongoose.Model<IRvBook>) ||
  mongoose.model<IRvBook>('RvBook', rvBookSchema, 'rvbooks');
