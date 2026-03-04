// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

describe('User model', () => {
  // Lazy import to avoid model registration conflicts
  async function getUser() {
    const { User } = await import('./user');
    return User;
  }

  it('creates a user with required fields', async () => {
    const User = await getUser();
    const user = await User.create({
      name: 'Alice',
      email: 'alice@example.com',
    });

    expect(user.name).toBe('Alice');
    expect(user.email).toBe('alice@example.com');
    expect(user._id).toBeDefined();
  });

  it('enforces unique email constraint', async () => {
    const User = await getUser();
    await User.syncIndexes();
    await User.create({ name: 'Alice', email: 'dupe@example.com' });

    await expect(
      User.create({ name: 'Bob', email: 'dupe@example.com' })
    ).rejects.toThrow();
  });

  it('allows optional fields to be undefined', async () => {
    const User = await getUser();
    const user = await User.create({
      name: 'Alice',
      email: 'alice2@example.com',
    });

    expect(user.password).toBeUndefined();
    expect(user.image).toBeUndefined();
    expect(user.emailVerified).toBeUndefined();
  });

  it('sets timestamps automatically', async () => {
    const User = await getUser();
    const user = await User.create({
      name: 'Alice',
      email: 'alice3@example.com',
    });

    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);
  });

  it('does not require password (OAuth users)', async () => {
    const User = await getUser();
    const user = await User.create({
      name: 'OAuth User',
      email: 'oauth@example.com',
      image: 'https://example.com/avatar.jpg',
    });

    expect(user.password).toBeUndefined();
    expect(user.image).toBe('https://example.com/avatar.jpg');
  });

  it('stores tosAcceptedAt field', async () => {
    const User = await getUser();
    const now = new Date();
    const user = await User.create({
      name: 'Tos User',
      email: 'tos@example.com',
      tosAcceptedAt: now,
    });

    expect(user.tosAcceptedAt).toEqual(now);
  });

  it('rejects creation without required name', async () => {
    const User = await getUser();
    await expect(
      User.create({ email: 'noname@example.com' })
    ).rejects.toThrow();
  });
});
