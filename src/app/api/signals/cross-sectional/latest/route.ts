import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { RvBook, RV_BOOK_NAME, type RvBookState, type RvValidationStatus } from '@/lib/models/rv-book';
import { RvSignal } from '@/lib/models/rv-signal';
import { RvStep } from '@/lib/models/rv-step';
import { CrossSectionalBook } from '@/lib/models/cross-sectional-book';
import { RV_V1 } from '@/lib/signals/cross-sectional/engine';
import { DRAWDOWN_ALERT } from '@/lib/paper-desk/rv-desk';
import {
  NEGATIVE_STREAK_FLAG,
  raisedAlertKinds,
  type RvBookView,
  type RvLastAlert,
  type RvLatestResponse,
  type RvLegacyBookView,
  type RvSignalView,
  type RvStepView,
} from '@/lib/paper-desk/rv-latest';

const LEGACY_BOOK_NAME = 'rv-8h-buffer2';

type SignalDoc = Omit<RvSignalView, 'createdAt'> & { createdAt: Date };
type StepDoc = Omit<RvStepView, 'createdAt'> & { createdAt: Date };
type BookDoc = RvBookState & {
  bookName: string;
  version: 'rv-v1';
  validationStatus: RvValidationStatus;
  validationRef: string | null;
  startedAt: Date;
  startBarTime: number | null;
  lastStepBarTime: number | null;
  createdAt: Date;
  updatedAt: Date;
};
type LegacyDoc = { equityMaker: number; equityTaker: number; lastProcessedBarTime: number | null };

function signalView(doc: SignalDoc): RvSignalView {
  return {
    version: doc.version,
    barTime: doc.barTime,
    barCloseTime: doc.barCloseTime,
    rows: doc.rows,
    ranked: doc.ranked,
    skipped: doc.skipped,
    inputs: doc.inputs,
    createdAt: doc.createdAt.toISOString(),
  };
}

function stepView(doc: StepDoc): RvStepView {
  return {
    bookName: doc.bookName,
    barTime: doc.barTime,
    fillTime: doc.fillTime,
    targets: doc.targets,
    taker: doc.taker,
    maker: doc.maker,
    bookAfter: doc.bookAfter,
    rebalanceHourUtc: doc.rebalanceHourUtc,
    isWeekend: doc.isWeekend,
    pendingReasons: doc.pendingReasons,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Every field except the lease, which is the desk's business only. */
function bookView(doc: BookDoc): RvBookView {
  return {
    bookName: doc.bookName,
    version: doc.version,
    validationStatus: doc.validationStatus,
    validationRef: doc.validationRef,
    startedAt: doc.startedAt.toISOString(),
    startBarTime: doc.startBarTime,
    lastStepBarTime: doc.lastStepBarTime,
    tracks: doc.tracks,
    equity: doc.equity,
    peakEquity: doc.peakEquity,
    alerts: doc.alerts,
    fillStats: doc.fillStats,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * GET /api/signals/cross-sectional/latest
 *
 * The rv-v1 paper desk as the dashboard shows it: the newest signal, the
 * newest step (which may be pending) and the newest completed step, the book,
 * the rule's costs, the newest step that raised a flag, and a summary of the
 * archived pre-rv-v1 book. Read-only.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await connectDB();

    const [signal, step, completedStep, book, flagged, legacy] = await Promise.all([
      RvSignal.findOne({ version: 'rv-v1' }).sort({ barTime: -1 }).lean<SignalDoc>(),
      RvStep.findOne({ bookName: RV_BOOK_NAME }).sort({ barTime: -1 }).lean<StepDoc>(),
      RvStep.findOne({ bookName: RV_BOOK_NAME, bookAfter: { $ne: null } }).sort({ barTime: -1 }).lean<StepDoc>(),
      RvBook.findOne({ bookName: RV_BOOK_NAME }).lean<BookDoc>(),
      // Walks the (bookName, barTime) index newest first and stops at the first match
      RvStep.findOne(
        {
          bookName: RV_BOOK_NAME,
          $or: [
            { 'bookAfter.alerts.drawdownTaker': true },
            { 'bookAfter.alerts.drawdownMaker': true },
            { 'bookAfter.alerts.negativeStreak': { $gte: NEGATIVE_STREAK_FLAG } },
          ],
        },
        { barTime: 1, fillTime: 1, 'bookAfter.alerts': 1 }
      )
        .sort({ barTime: -1 })
        .lean<Pick<StepDoc, 'barTime' | 'fillTime'> & { bookAfter: Pick<RvBookState, 'alerts'> }>(),
      CrossSectionalBook.findOne(
        { bookName: LEGACY_BOOK_NAME },
        { equityMaker: 1, equityTaker: 1, lastProcessedBarTime: 1 }
      ).lean<LegacyDoc>(),
    ]);

    const lastAlert: RvLastAlert | null = flagged
      ? { barTime: flagged.barTime, fillTime: flagged.fillTime, kinds: raisedAlertKinds(flagged.bookAfter.alerts) }
      : null;
    const legacyView: RvLegacyBookView | null = legacy
      ? {
          bookName: LEGACY_BOOK_NAME,
          equityMaker: legacy.equityMaker,
          equityTaker: legacy.equityTaker,
          lastProcessedBarTime: legacy.lastProcessedBarTime,
        }
      : null;

    const body: RvLatestResponse = {
      success: true,
      signal: signal ? signalView(signal) : null,
      step: step ? stepView(step) : null,
      completedStep: completedStep ? stepView(completedStep) : null,
      book: book ? bookView(book) : null,
      costs: {
        takerFee: RV_V1.costs.takerFee,
        makerFee: RV_V1.costs.makerFee,
        takerSlippageBps: RV_V1.costs.takerSlippageBps,
      },
      rule: {
        weights: { ...RV_V1.weights },
        legs: RV_V1.legs,
        startingEquity: RV_V1.startingEquity,
        drawdownFlag: DRAWDOWN_ALERT,
      },
      lastAlert,
      legacy: legacyView,
    };
    return NextResponse.json(body);
  } catch (error) {
    console.error('[cross-sectional/latest] read failed:', error);
    return NextResponse.json({ success: false, error: 'Could not read the rv-v1 desk' }, { status: 500 });
  }
}
