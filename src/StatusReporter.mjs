/**
 * StatusReporter — reads checkpoint files and displays migration progress.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Checkpoint } from './Checkpoint.mjs';

const DEFAULT_CHECKPOINTS = join(homedir(), '.aw2ms365', 'checkpoints');

export class StatusReporter {

  constructor(config) {
    this.checkpointDirectory = config.options?.checkpointDirectory || DEFAULT_CHECKPOINTS;
    this.checkpoint = new Checkpoint(this.checkpointDirectory);
  }

  printStatus() {
    const allStates = this.checkpoint.loadAll();
    const folders = Object.values(allStates);

    if (folders.length === 0) {
      console.log('No migration in progress. Run "aw2ms365 migrate <config.yaml>" to start.');
      return;
    }

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Migration Status                                          ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    let totalMessages = 0;
    let totalImported = 0;
    let totalFailed = 0;

    for (const state of folders) {
      const processed = state.imported + state.failed + state.skipped;
      const percentComplete = state.totalUids > 0
        ? Math.round((processed / state.totalUids) * 100)
        : 100;
      const isComplete = state.completedAt != null;
      const indicator = isComplete ? '✓' : '…';

      console.log(
        `  ${indicator} ${state.folder.padEnd(30)} ${percentComplete}%  ${state.imported} ok / ${state.failed} fail / ${state.totalUids} total`,
      );

      totalMessages += state.totalUids;
      totalImported += state.imported;
      totalFailed += state.failed;
    }

    const overallPercent = totalMessages > 0
      ? Math.round(((totalImported + totalFailed) / totalMessages) * 100)
      : 100;

    console.log(`\n  Overall: ${overallPercent}% — ${totalImported} imported, ${totalFailed} failed, ${totalMessages} total`);

    if (totalFailed > 0) {
      console.log('\n  Failed messages:');
      for (const state of folders) {
        for (const failure of state.failures.slice(-5)) {
          console.log(`    [${state.folder}] UID ${failure.uid}: ${failure.error}`);
        }
      }
      console.log('\n  Run "aw2ms365 migrate" again to retry failed messages.');
    }
  }
}
