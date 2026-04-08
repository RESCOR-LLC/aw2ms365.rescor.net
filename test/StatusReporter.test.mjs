import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Checkpoint } from '../src/Checkpoint.mjs';
import { StatusReporter } from '../src/StatusReporter.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-status-checkpoints');

describe('StatusReporter', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) { rmSync(TEST_DIR, { recursive: true }); }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) { rmSync(TEST_DIR, { recursive: true }); }
  });

  it('reports no migration when checkpoints are empty', () => {
    const reporter = new StatusReporter({ options: { checkpointDirectory: TEST_DIR } });
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    reporter.printStatus();
    console.log = originalLog;
    expect(logs.join('\n')).toContain('No migration in progress');
  });

  it('reports progress from checkpoint files', () => {
    const checkpoint = new Checkpoint(TEST_DIR);
    let state = checkpoint.createInitialState('INBOX', 100);
    for (let i = 0; i < 50; i++) { state = checkpoint.updateAfterSuccess(state); }
    for (let i = 0; i < 5; i++) { state = checkpoint.updateAfterFailure(state, i, 'test error'); }
    checkpoint.save('INBOX', state);

    const reporter = new StatusReporter({ options: { checkpointDirectory: TEST_DIR } });
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    reporter.printStatus();
    console.log = originalLog;

    const output = logs.join('\n');
    expect(output).toContain('INBOX');
    expect(output).toContain('50 ok');
    expect(output).toContain('5 fail');
  });
});
