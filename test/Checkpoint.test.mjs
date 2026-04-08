import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Checkpoint } from '../src/Checkpoint.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-checkpoints');

describe('Checkpoint', () => {
  let checkpoint;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) { rmSync(TEST_DIR, { recursive: true }); }
    checkpoint = new Checkpoint(TEST_DIR);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) { rmSync(TEST_DIR, { recursive: true }); }
  });

  it('creates directory on construction', () => {
    expect(existsSync(TEST_DIR)).toBe(true);
  });

  it('returns null for nonexistent folder', () => {
    expect(checkpoint.load('NoSuchFolder')).toBeNull();
  });

  it('creates initial state with correct fields', () => {
    const state = checkpoint.createInitialState('INBOX', 100);
    expect(state.folder).toBe('INBOX');
    expect(state.totalUids).toBe(100);
    expect(state.lastCompletedIndex).toBe(-1);
    expect(state.imported).toBe(0);
    expect(state.failed).toBe(0);
    expect(state.skipped).toBe(0);
    expect(state.failures).toEqual([]);
    expect(state.startedAt).toBeDefined();
  });

  it('saves and loads state', () => {
    const state = checkpoint.createInitialState('INBOX', 50);
    checkpoint.save('INBOX', state);
    const loaded = checkpoint.load('INBOX');
    expect(loaded.folder).toBe('INBOX');
    expect(loaded.totalUids).toBe(50);
  });

  it('updates after success', () => {
    let state = checkpoint.createInitialState('INBOX', 10);
    state = checkpoint.updateAfterSuccess(state);
    expect(state.lastCompletedIndex).toBe(0);
    expect(state.imported).toBe(1);
    state = checkpoint.updateAfterSuccess(state);
    expect(state.lastCompletedIndex).toBe(1);
    expect(state.imported).toBe(2);
  });

  it('updates after failure', () => {
    let state = checkpoint.createInitialState('INBOX', 10);
    state = checkpoint.updateAfterFailure(state, 42, 'Network error');
    expect(state.lastCompletedIndex).toBe(0);
    expect(state.failed).toBe(1);
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0].uid).toBe(42);
    expect(state.failures[0].error).toBe('Network error');
  });

  it('updates after skip', () => {
    let state = checkpoint.createInitialState('INBOX', 10);
    state = checkpoint.updateAfterSkip(state);
    expect(state.lastCompletedIndex).toBe(0);
    expect(state.skipped).toBe(1);
  });

  it('sanitizes folder names with special characters', () => {
    const state = checkpoint.createInitialState('Folder/With:Special*Chars', 5);
    checkpoint.save('Folder/With:Special*Chars', state);
    const loaded = checkpoint.load('Folder/With:Special*Chars');
    expect(loaded.folder).toBe('Folder/With:Special*Chars');
  });

  it('loads all checkpoints', () => {
    checkpoint.save('INBOX', checkpoint.createInitialState('INBOX', 100));
    checkpoint.save('Sent', checkpoint.createInitialState('Sent', 50));
    const all = checkpoint.loadAll();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['INBOX'].totalUids).toBe(100);
    expect(all['Sent'].totalUids).toBe(50);
  });
});
