import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResearchNote,
  RESEARCH_NOTE_CATEGORIES,
  MAX_RESEARCH_NOTES_PER_USER,
} from './research-note';

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe('ResearchNote model', () => {
  it('creates a note with required fields', async () => {
    const note = await ResearchNote.create({
      userId: 'user-1',
      title: 'Test strategy',
      category: 'strategy',
    });

    expect(note.userId).toBe('user-1');
    expect(note.title).toBe('Test strategy');
    expect(note.category).toBe('strategy');
    expect(note.content).toBe('');
    expect(note.tags).toEqual([]);
    expect(note.relatedSymbols).toEqual([]);
    expect(note.isPinned).toBe(false);
    expect(note.createdAt).toBeInstanceOf(Date);
    expect(note.updatedAt).toBeInstanceOf(Date);
  });

  it('creates a note with all fields', async () => {
    const note = await ResearchNote.create({
      userId: 'user-1',
      title: 'Full note',
      content: '## Detailed strategy',
      category: 'concept',
      tags: ['scalp', 'momentum'],
      relatedSymbols: ['BTCUSDT', 'ETHUSDT'],
      isPinned: true,
    });

    expect(note.title).toBe('Full note');
    expect(note.content).toBe('## Detailed strategy');
    expect(note.category).toBe('concept');
    expect(note.tags).toEqual(['scalp', 'momentum']);
    expect(note.relatedSymbols).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(note.isPinned).toBe(true);
  });

  it('rejects invalid category', async () => {
    await expect(
      ResearchNote.create({
        userId: 'user-1',
        title: 'Bad category',
        category: 'invalid',
      })
    ).rejects.toThrow();
  });

  it('rejects missing title', async () => {
    await expect(
      ResearchNote.create({
        userId: 'user-1',
        category: 'rule',
      })
    ).rejects.toThrow();
  });

  it('rejects missing userId', async () => {
    await expect(
      ResearchNote.create({
        title: 'No user',
        category: 'rule',
      })
    ).rejects.toThrow();
  });

  it('accepts all valid categories', async () => {
    for (const category of RESEARCH_NOTE_CATEGORIES) {
      const note = await ResearchNote.create({
        userId: 'user-cat',
        title: `Category ${category}`,
        category,
      });
      expect(note.category).toBe(category);
    }
  });

  it('queries by tags', async () => {
    await ResearchNote.create({
      userId: 'user-tag-query',
      title: 'Tagged note',
      category: 'observation',
      tags: ['unique-tag-test'],
    });

    const found = await ResearchNote.find({
      userId: 'user-tag-query',
      tags: 'unique-tag-test',
    });
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('Tagged note');
  });

  it('queries by category', async () => {
    await ResearchNote.create({
      userId: 'user-cat-query',
      title: 'Checklist note',
      category: 'checklist',
    });

    const found = await ResearchNote.find({
      userId: 'user-cat-query',
      category: 'checklist',
    });
    expect(found).toHaveLength(1);
  });

  it('exports RESEARCH_NOTE_CATEGORIES', () => {
    expect(RESEARCH_NOTE_CATEGORIES).toEqual([
      'strategy',
      'concept',
      'rule',
      'checklist',
      'observation',
    ]);
  });

  it('exports MAX_RESEARCH_NOTES_PER_USER', () => {
    expect(MAX_RESEARCH_NOTES_PER_USER).toBe(200);
  });
});
