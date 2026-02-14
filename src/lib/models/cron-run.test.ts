import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CronRun } from './cron-run';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('CronRun Model', () => {
  it('should create a valid CronRun document', async () => {
    const cronRun = await CronRun.create({
      type: 'monthly_optimization',
      scheduledAt: new Date(),
      status: 'scheduled',
      jobs: [
        { tradingStyle: 'scalping', status: 'pending' },
        { tradingStyle: 'day_trading', status: 'pending' },
      ],
      summary: {
        totalJobs: 2,
        completedJobs: 0,
        failedJobs: 0,
        activatedTemplates: 0,
      },
    });

    expect(cronRun._id).toBeDefined();
    expect(cronRun.type).toBe('monthly_optimization');
    expect(cronRun.status).toBe('scheduled');
    expect(cronRun.jobs).toHaveLength(2);
  });

  it('should set default values for optional fields', async () => {
    const cronRun = await CronRun.create({
      type: 'monthly_optimization',
      scheduledAt: new Date(),
    });

    expect(cronRun.status).toBe('scheduled');
    expect(cronRun.jobs).toEqual([]);
    expect(cronRun.summary.totalJobs).toBe(0);
    expect(cronRun.summary.completedJobs).toBe(0);
    expect(cronRun.summary.failedJobs).toBe(0);
    expect(cronRun.summary.activatedTemplates).toBe(0);
    expect(cronRun.startedAt).toBeNull();
    expect(cronRun.completedAt).toBeNull();
    expect(cronRun.error).toBeNull();
  });

  it('should validate trading style enum', async () => {
    await expect(
      CronRun.create({
        type: 'monthly_optimization',
        scheduledAt: new Date(),
        jobs: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { tradingStyle: 'invalid_style' as any, status: 'pending' },
        ],
      })
    ).rejects.toThrow();
  });

  it('should validate job status enum', async () => {
    await expect(
      CronRun.create({
        type: 'monthly_optimization',
        scheduledAt: new Date(),
        jobs: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { tradingStyle: 'scalping', status: 'invalid_status' as any },
        ],
      })
    ).rejects.toThrow();
  });

  it('should validate cron run status enum', async () => {
    await expect(
      CronRun.create({
        type: 'monthly_optimization',
        scheduledAt: new Date(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        status: 'invalid_status' as any,
      })
    ).rejects.toThrow();
  });

  it('should store job details correctly', async () => {
    const jobId = new mongoose.Types.ObjectId();

    const cronRun = await CronRun.create({
      type: 'monthly_optimization',
      scheduledAt: new Date(),
      jobs: [
        {
          tradingStyle: 'day_trading',
          symbol: 'BTCUSDT',
          interval: '1h',
          jobId,
          status: 'running',
          startedAt: new Date(),
          activated: false,
          activationReason: 'Below threshold',
        },
      ],
    });

    expect(cronRun.jobs[0].tradingStyle).toBe('day_trading');
    expect(cronRun.jobs[0].symbol).toBe('BTCUSDT');
    expect(cronRun.jobs[0].interval).toBe('1h');
    expect(cronRun.jobs[0].jobId?.toString()).toBe(jobId.toString());
    expect(cronRun.jobs[0].status).toBe('running');
    expect(cronRun.jobs[0].activated).toBe(false);
    expect(cronRun.jobs[0].activationReason).toBe('Below threshold');
  });

  it('should update job status correctly', async () => {
    const cronRun = await CronRun.create({
      type: 'monthly_optimization',
      scheduledAt: new Date(),
      jobs: [
        { tradingStyle: 'scalping', status: 'pending' },
      ],
    });

    await CronRun.updateOne(
      { _id: cronRun._id, 'jobs.tradingStyle': 'scalping' },
      {
        $set: {
          'jobs.$.status': 'completed',
          'jobs.$.completedAt': new Date(),
        },
      }
    );

    const updated = await CronRun.findById(cronRun._id);
    expect(updated?.jobs[0].status).toBe('completed');
    expect(updated?.jobs[0].completedAt).toBeDefined();
  });

  it('should update summary statistics correctly', async () => {
    const cronRun = await CronRun.create({
      type: 'monthly_optimization',
      scheduledAt: new Date(),
      summary: {
        totalJobs: 4,
        completedJobs: 0,
        failedJobs: 0,
        activatedTemplates: 0,
      },
    });

    await CronRun.updateOne(
      { _id: cronRun._id },
      {
        $set: {
          'summary.completedJobs': 3,
          'summary.failedJobs': 1,
          'summary.activatedTemplates': 2,
        },
      }
    );

    const updated = await CronRun.findById(cronRun._id);
    expect(updated?.summary.completedJobs).toBe(3);
    expect(updated?.summary.failedJobs).toBe(1);
    expect(updated?.summary.activatedTemplates).toBe(2);
  });

  it('should have createdAt and updatedAt timestamps', async () => {
    const cronRun = await CronRun.create({
      type: 'monthly_optimization',
      scheduledAt: new Date(),
    });

    expect(cronRun.createdAt).toBeDefined();
    expect(cronRun.updatedAt).toBeDefined();
    expect(cronRun.createdAt).toBeInstanceOf(Date);
    expect(cronRun.updatedAt).toBeInstanceOf(Date);
  });
});
