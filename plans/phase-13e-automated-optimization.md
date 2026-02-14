# Phase 13E: Automated System Template Optimization

## Overview

**Purpose**: Automate the monthly optimization of all trading style templates using a scheduled cron job.

**Why**: Manual optimization is time-consuming. Automated monthly optimization ensures templates stay current with evolving market conditions without admin intervention.

**What**: Cron endpoint that runs on the 1st of each month, optimizing all 4 trading styles against top volume symbols, with optional auto-activation for significant improvements.

## Architecture Decisions

### Cron Implementation
- **Approach**: Vercel Cron + GitHub Actions fallback
- **Frequency**: Monthly (1st of month at 00:00 UTC)
- **Authentication**: Bearer token via `CRON_SECRET` env var
- **Timeout**: Use background job pattern (no response wait)

### Symbol Selection
- **Method**: Query Binance 24hr ticker for top 5 USDT pairs by volume
- **Cache**: Store top symbols in Redis with 24hr TTL
- **Fallback**: Hardcoded list if Binance API fails

### Auto-Activation Strategy
- **Threshold**: New template must improve Sharpe ratio by ≥10%
- **Safety**: Require minimum robustness (same filters as optimization)
- **Notification**: Log activation decisions to database
- **Rollback**: Keep previous template version for manual rollback

### Job Scheduling
- **Sequential**: Process styles one at a time (4 jobs)
- **Symbol Rotation**: Each style uses different symbol from top 5
- **Progress Tracking**: Store monthly run status in database

## Implementation Plan

### Step 1: Cron Job Model

**File**: `src/lib/models/cron-run.ts`

**Schema**:
```typescript
interface ICronRun {
  type: 'monthly_optimization'
  scheduledAt: Date
  startedAt: Date | null
  completedAt: Date | null
  status: 'scheduled' | 'running' | 'completed' | 'failed'

  jobs: {
    tradingStyle: TradingStyle
    symbol: string
    jobId: ObjectId | null
    status: 'pending' | 'running' | 'completed' | 'failed'
    startedAt: Date | null
    completedAt: Date | null
    error: string | null
    activated: boolean  // Auto-activation occurred
    activationReason: string | null  // Why activated/not activated
  }[]

  summary: {
    totalJobs: number
    completedJobs: number
    failedJobs: number
    activatedTemplates: number
  }

  error: string | null
  createdAt: Date
  updatedAt: Date
}
```

**Indexes**:
- `(type, scheduledAt)` - query cron runs by type and date
- `(status, scheduledAt)` - find pending/running jobs

### Step 2: Top Symbols Utility

**File**: `src/lib/optimization/top-symbols.ts`

**Functions**:

```typescript
interface SymbolVolume {
  symbol: string
  quoteVolume: number  // 24hr USDT volume
}

/**
 * Fetch top N USDT symbols by 24hr volume from Binance
 * Caches results in Redis for 24hrs
 */
async function getTopSymbols(
  count: number = 5,
  forceRefresh: boolean = false
): Promise<string[]>

/**
 * Fallback symbols if Binance API fails
 */
const FALLBACK_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'ADAUSDT',
]
```

**Algorithm**:
1. Check Redis cache key `top-symbols:24h`
2. If cached and not forceRefresh, return cached list
3. Otherwise, fetch from Binance `GET /api/v3/ticker/24hr`
4. Filter for USDT pairs only
5. Sort by `quoteVolume` descending
6. Take top N
7. Cache in Redis with 24hr TTL
8. Return symbol list

### Step 3: Auto-Activation Logic

**File**: `src/lib/optimization/auto-activation.ts`

**Functions**:

```typescript
interface ActivationDecision {
  shouldActivate: boolean
  reason: string
  metrics: {
    currentSharpe: number
    newSharpe: number
    improvement: number  // Percentage
  }
}

/**
 * Determine if optimized template should auto-activate
 * Requires ≥10% Sharpe improvement
 */
async function shouldAutoActivate(
  tradingStyle: TradingStyle,
  optimizedTemplate: ISignalTemplate
): Promise<ActivationDecision>

/**
 * Execute auto-activation
 * Logs decision to OptimizationJob
 */
async function executeAutoActivation(
  jobId: ObjectId,
  decision: ActivationDecision
): Promise<void>
```

**Auto-Activation Criteria**:
1. New template exists and passed robustness filters
2. Current active template exists
3. New Sharpe ≥ current Sharpe × 1.10 (10% improvement)
4. New template has ≥ 5 contributing backtest results
5. All robustness filters passed

**Rejection Reasons**:
- "Improvement below 10% threshold"
- "New template failed robustness checks"
- "Insufficient backtest results"
- "No current template to compare against"

### Step 4: Monthly Optimization Orchestrator

**File**: `src/lib/optimization/monthly-orchestrator.ts`

**Main Function**:

```typescript
interface MonthlyOptimizationConfig {
  cronRunId: ObjectId
  topSymbols: string[]
  months: number  // Historical data months (default 6)
  autoActivate: boolean  // Default true
}

interface MonthlyOptimizationResult {
  cronRun: ICronRun
  completedJobs: number
  failedJobs: number
  activatedTemplates: number
  errors: string[]
}

/**
 * Orchestrate monthly optimization for all trading styles
 * Runs sequentially to avoid resource contention
 */
async function runMonthlyOptimization(
  config: MonthlyOptimizationConfig
): Promise<MonthlyOptimizationResult>
```

**Algorithm**:

```typescript
1. Update CronRun status to 'running'

2. For each trading style (scalping, day_trading, swing_trading, position_trading):
   a. Select symbol from topSymbols (round-robin: style index % symbols.length)
   b. Select appropriate interval for style:
      - scalping: 5m
      - day_trading: 1h
      - swing_trading: 4h
      - position_trading: 1d
   c. Create OptimizationJob via existing API logic
   d. Run walk-forward optimization
   e. If optimization succeeds:
      - Check auto-activation criteria
      - If threshold met, activate template
      - Log activation decision
   f. Update CronRun job status
   g. Handle errors gracefully (log, continue to next style)

3. Update CronRun summary statistics

4. Update CronRun status to 'completed' or 'failed'

5. Return result summary
```

**Error Handling**:
- Individual job failures don't stop the entire run
- Errors logged to CronRun.jobs[].error
- Continue to next trading style
- Mark CronRun as 'completed' even if some jobs fail
- Mark as 'failed' only if orchestration itself fails

### Step 5: Cron API Endpoint

**File**: `src/app/api/cron/monthly-optimization/route.ts`

**Endpoint**: `POST /api/cron/monthly-optimization`

**Authentication**: Bearer token matching `CRON_SECRET`

```typescript
export async function POST(req: Request) {
  // 1. Verify authorization header
  const authHeader = req.headers.get('authorization')
  const token = authHeader?.replace('Bearer ', '')
  if (token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 2. Check for existing running job
  const existingRun = await CronRun.findOne({
    type: 'monthly_optimization',
    status: 'running',
  })
  if (existingRun) {
    return NextResponse.json({
      message: 'Optimization already running',
      cronRunId: existingRun._id
    }, { status: 409 })
  }

  // 3. Create CronRun document
  const cronRun = await CronRun.create({
    type: 'monthly_optimization',
    scheduledAt: new Date(),
    status: 'scheduled',
    jobs: [
      { tradingStyle: 'scalping', status: 'pending' },
      { tradingStyle: 'day_trading', status: 'pending' },
      { tradingStyle: 'swing_trading', status: 'pending' },
      { tradingStyle: 'position_trading', status: 'pending' },
    ],
  })

  // 4. Fetch top symbols
  const topSymbols = await getTopSymbols(5)

  // 5. Start background job (don't await - return immediately)
  runMonthlyOptimization({
    cronRunId: cronRun._id,
    topSymbols,
    months: 6,
    autoActivate: true,
  }).catch((error) => {
    // Log error to CronRun
    CronRun.updateOne(
      { _id: cronRun._id },
      { status: 'failed', error: error.message }
    )
  })

  // 6. Return immediately
  return NextResponse.json({
    message: 'Monthly optimization started',
    cronRunId: cronRun._id,
    topSymbols,
  })
}
```

**Response**:
```json
{
  "message": "Monthly optimization started",
  "cronRunId": "507f1f77bcf86cd799439011",
  "topSymbols": ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "ADAUSDT"]
}
```

### Step 6: Cron Status Endpoint

**File**: `src/app/api/cron/monthly-optimization/[cronRunId]/route.ts`

**Endpoint**: `GET /api/cron/monthly-optimization/:cronRunId`

**Authentication**: Admin-only or CRON_SECRET

**Response**:
```typescript
{
  cronRun: ICronRun,
  progress: {
    percent: number,        // 0-100
    currentJob: number,     // 1-4
    totalJobs: number,      // 4
    completedJobs: number,
    failedJobs: number,
    activatedTemplates: number,
  }
}
```

### Step 7: Vercel Cron Configuration

**File**: `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/cron/monthly-optimization",
      "schedule": "0 0 1 * *"
    }
  ]
}
```

**Schedule**: `0 0 1 * *` = 00:00 UTC on 1st of each month

**Note**: Vercel cron only works on production deployments

### Step 8: GitHub Actions Fallback

**File**: `.github/workflows/monthly-optimization.yml`

```yaml
name: Monthly Template Optimization

on:
  schedule:
    # Run at 00:00 UTC on 1st of each month
    - cron: '0 0 1 * *'
  workflow_dispatch:  # Allow manual trigger

jobs:
  optimize:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger optimization
        run: |
          curl -X POST ${{ secrets.PRODUCTION_URL }}/api/cron/monthly-optimization \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            -H "Content-Type: application/json"
```

**Secrets Required**:
- `PRODUCTION_URL`: Production deployment URL
- `CRON_SECRET`: Bearer token for authentication

### Step 9: Admin UI - Cron History

**File**: `src/components/admin/optimization/CronHistory.tsx`

**Features**:
- Table showing past monthly optimization runs
- Columns: Date, Status, Jobs (4/4), Activated, Duration, Actions
- Expandable rows showing individual job details
- Status badges (completed, running, failed)
- Auto-refresh every 30s when runs are active

**Integration**: Add new tab to `OptimizationDashboard.tsx`

```typescript
<Tabs>
  <TabsList>
    <TabsTrigger value="optimize">Optimize</TabsTrigger>
    <TabsTrigger value="history">History</TabsTrigger>
    <TabsTrigger value="cron">Scheduled Runs</TabsTrigger>
    <TabsTrigger value="compare">Compare</TabsTrigger>
  </TabsList>

  <TabsContent value="cron">
    <CronHistory />
  </TabsContent>
</Tabs>
```

### Step 10: Manual Trigger Endpoint

**File**: `src/app/api/admin/trigger-monthly-optimization/route.ts`

**Endpoint**: `POST /api/admin/trigger-monthly-optimization`

**Auth**: Admin-only

**Purpose**: Allow admins to manually trigger monthly optimization outside of schedule

**Request Body**:
```typescript
{
  symbols?: string[]       // Optional override, defaults to top 5
  months?: number          // Optional override, defaults to 6
  autoActivate?: boolean   // Optional override, defaults to true
}
```

## File Structure

**New Files** (10):
```
src/lib/models/cron-run.ts
src/lib/optimization/top-symbols.ts
src/lib/optimization/auto-activation.ts
src/lib/optimization/monthly-orchestrator.ts
src/app/api/cron/monthly-optimization/route.ts
src/app/api/cron/monthly-optimization/[cronRunId]/route.ts
src/app/api/admin/trigger-monthly-optimization/route.ts
src/components/admin/optimization/CronHistory.tsx
vercel.json
.github/workflows/monthly-optimization.yml
```

**New Test Files** (8):
```
src/lib/models/cron-run.test.ts
src/lib/optimization/top-symbols.test.ts
src/lib/optimization/auto-activation.test.ts
src/lib/optimization/monthly-orchestrator.test.ts
src/app/api/cron/monthly-optimization/route.test.ts
src/app/api/cron/monthly-optimization/[cronRunId]/route.test.ts
src/app/api/admin/trigger-monthly-optimization/route.test.ts
src/components/admin/optimization/CronHistory.test.tsx
```

**Modified Files** (2):
```
src/components/admin/optimization/OptimizationDashboard.tsx (add Cron tab)
.env.example (add CRON_SECRET)
```

## Testing Strategy

### Unit Tests

**Top Symbols**:
- Fetches and sorts by volume correctly
- Filters USDT pairs only
- Caches results in Redis
- Respects forceRefresh flag
- Falls back to hardcoded list on API failure

**Auto-Activation**:
- Correctly calculates Sharpe improvement percentage
- Applies 10% threshold correctly
- Handles edge cases (no current template, NaN Sharpe)
- Generates appropriate activation/rejection reasons

**Monthly Orchestrator**:
- Creates jobs for all 4 trading styles
- Assigns correct intervals per style
- Distributes symbols via round-robin
- Handles individual job failures gracefully
- Updates CronRun status correctly
- Calls auto-activation when enabled

### Integration Tests

**Cron API**:
- Rejects requests without CRON_SECRET
- Rejects concurrent runs
- Creates CronRun document
- Returns immediately (doesn't wait for completion)
- Background job executes successfully

**Manual Trigger**:
- Admin-only access enforced
- Accepts optional overrides
- Creates CronRun document
- Triggers orchestration

### E2E Tests (Optional)

**Admin Workflow**:
1. Admin triggers manual optimization
2. Verify CronRun created
3. Poll status until completed
4. Verify all 4 jobs executed
5. Verify auto-activation decisions

## Environment Variables

**Required**:
```bash
CRON_SECRET=your-secure-random-token
```

**Optional** (GitHub Actions):
```bash
PRODUCTION_URL=https://your-domain.com
```

## Verification Checklist

After implementation:

1. ✅ Run `npm run lint` - zero errors
2. ✅ Run `npm run typecheck` - zero errors
3. ✅ Run `npm run test` - all unit tests pass
4. ✅ Run `npm run build` - clean build
5. ✅ Manual test: Trigger cron endpoint
   - Verify CronRun created in MongoDB
   - Monitor progress via status endpoint
   - Check OptimizationJob documents created
   - Verify auto-activation logic
6. ✅ Manual test: Admin trigger endpoint
7. ✅ Verify Redis caching for top symbols
8. ✅ Test Vercel cron configuration (deploy to staging)

## Performance Considerations

**Timing**:
- 4 trading styles × 6 months × 50 candidates ≈ 4 optimization jobs
- Per job: ~1-2 minutes with optimized engine
- Total runtime: ~5-10 minutes for all 4 styles
- Acceptable for monthly schedule

**Resource Usage**:
- Sequential execution prevents CPU contention
- Background job pattern prevents timeout issues
- Redis caching reduces Binance API calls

**Monitoring**:
- CronRun documents provide full audit trail
- Individual job errors logged
- Auto-activation decisions recorded

## Deployment Notes

### Vercel

1. Deploy to production with `vercel.json` cron config
2. Vercel automatically schedules cron jobs
3. Verify in Vercel dashboard: Settings → Cron Jobs

### Self-Hosted (Docker)

1. Add cron job to Docker container via crontab
2. Alternative: Use system cron to curl endpoint
3. Example crontab entry:
   ```bash
   0 0 1 * * curl -X POST http://localhost:3000/api/cron/monthly-optimization \
     -H "Authorization: Bearer $CRON_SECRET"
   ```

## Security Considerations

**CRON_SECRET**:
- Use strong random token (min 32 characters)
- Store in environment variables only
- Rotate periodically
- Never commit to git

**Auto-Activation**:
- 10% threshold prevents minor fluctuations
- Robustness filters ensure quality
- Previous templates preserved for rollback
- Admin notification on activation

## Next Steps (Future Enhancements)

After Phase 13E:

1. **Notification System**: Email admins on cron completion
2. **Slack Integration**: Post activation decisions to Slack channel
3. **Performance Dashboards**: Charts showing template performance over time
4. **A/B Testing**: Run old and new templates in parallel for comparison
5. **Multi-Timeframe Optimization**: Optimize across multiple intervals simultaneously

## Implementation Order

**Recommended sequence**:
1. Models and utilities (cron-run, top-symbols, auto-activation)
2. Core orchestrator (monthly-orchestrator.ts)
3. API endpoints (cron endpoints, manual trigger)
4. Configuration files (vercel.json, GitHub Actions)
5. Admin UI (CronHistory component)
6. Tests (unit, integration)
7. Manual verification
8. Deployment

**Estimated effort**: 6-8 hours
