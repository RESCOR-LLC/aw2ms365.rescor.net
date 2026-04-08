/**
 * MigrationEngine — orchestrates the full migration pipeline.
 *
 * For each source folder:
 *   1. Get all message UIDs from WorkMail IMAP
 *   2. Load checkpoint (resume from last completed UID)
 *   3. For each remaining UID: fetch MIME → import to EWS → checkpoint
 *   4. Report per-folder and overall results
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WorkMailSource } from './WorkMailSource.mjs';
import { Ms365Target } from './Ms365Target.mjs';
import { Checkpoint } from './Checkpoint.mjs';

const DEFAULT_CHECKPOINTS = join(homedir(), '.aw2ms365', 'checkpoints');
const DEFAULT_RATE_LIMIT = 1;
const DEFAULT_MAX_RETRIES = 3;
const CHECKPOINT_INTERVAL = 10;

export class MigrationEngine {

  constructor(config) {
    this.config = config;
    this.skipFolders = new Set(
      (config.options?.skipFolders || ['Deleted Items', 'Junk Email', 'Drafts'])
        .map(folder => folder.toLowerCase()),
    );
    this.rateLimit = config.options?.rateLimit || DEFAULT_RATE_LIMIT;
    this.maxRetries = config.options?.maxRetries || DEFAULT_MAX_RETRIES;
    this.checkpointDirectory = config.options?.checkpointDirectory || DEFAULT_CHECKPOINTS;
    this.checkpoint = new Checkpoint(this.checkpointDirectory);
    this.source = null;
    this.target = null;
  }

  // ── Public entry points ──

  async run() {
    this._printBanner('AWS WorkMail to Microsoft 365 Migration');
    try {
      await this._connect();
      const folders = await this._discoverFolders();
      for (const folder of folders) { await this._migrateFolder(folder); }
      this._printSummary();
    } catch (error) {
      console.error(`\nFatal error: ${this._sanitizeError(error.message)}`);
      process.exit(1);
    } finally {
      this._disconnect();
    }
  }

  async verify() {
    this._printBanner('Verification');
    try {
      await this._connect();
      const folders = await this._discoverFolders();
      this._printVerificationResults(await this._compareAllFolders(folders));
    } finally {
      this._disconnect();
    }
  }

  // ── Connection ──

  async _connect() {
    console.log('Connecting to WorkMail IMAP...');
    this.source = new WorkMailSource(this.config);
    await this.source.connect();
    console.log(`  Connected as ${this.config.source.user}\n`);

    console.log('Authenticating with MS365...');
    this.target = new Ms365Target(this.config);
    await this.target.authenticate();
    console.log(`  Target mailbox: ${this.config.destination.mailbox}\n`);
  }

  _disconnect() {
    if (this.source) { this.source.disconnect(); }
  }

  // ── Folder discovery ──

  async _discoverFolders() {
    console.log('Discovering folders...\n');
    const allFolders = await this.source.listFolders();
    const eligibleFolders = [];

    for (const folder of allFolders) {
      const isSkipped = this.skipFolders.has(folder.name.toLowerCase());
      const isNoSelect = folder.attributes.includes('\\Noselect');

      if (isSkipped) {
        console.log(`  SKIP  ${folder.name}`);
      } else if (isNoSelect) {
        console.log(`  SKIP  ${folder.name} (not selectable)`);
      } else {
        const folderInfo = await this.source.openFolder(folder.name);
        console.log(`  OK    ${folder.name} (${folderInfo.totalMessages} messages)`);
        eligibleFolders.push({ name: folder.name, totalMessages: folderInfo.totalMessages });
      }
    }

    console.log(`\n  ${eligibleFolders.length} folder(s) to migrate\n`);
    return eligibleFolders;
  }

  // ── Per-folder migration ──

  async _migrateFolder(folder) {
    console.log(`\n── ${folder.name} ──\n`);

    const uids = await this.source.getMessageUids(folder.name);
    if (uids.length === 0) { console.log('  (empty folder)'); return; }

    let state = this._loadOrCreateCheckpoint(folder.name, uids.length);
    const startIndex = state.lastCompletedIndex + 1;

    if (startIndex >= uids.length) {
      const skipInfo = state.skipped > 0 ? `, ${state.skipped} dup skipped` : '';
      console.log(`  Already complete (${state.imported} imported, ${state.failed} failed${skipInfo})`);
      return;
    }

    if (state.lastCompletedIndex >= 0) {
      console.log(`  Resuming from message ${startIndex + 1}/${uids.length} (${state.imported} already imported)\n`);
    }

    const destinationFolderId = await this.target.ensureFolder(folder.name);
    state = await this._processMessages(uids, startIndex, destinationFolderId, folder.name, state);

    state.completedAt = new Date().toISOString();
    this.checkpoint.save(folder.name, state);
    console.log(`\n  Done: ${state.imported} imported, ${state.failed} failed, ${state.skipped} skipped`);
  }

  _loadOrCreateCheckpoint(folderName, totalUids) {
    const existing = this.checkpoint.load(folderName);
    return existing || this.checkpoint.createInitialState(folderName, totalUids);
  }

  async _processMessages(uids, startIndex, destinationFolderId, folderName, state) {
    const delayMilliseconds = Math.ceil(1000 / this.rateLimit);
    const folderStartTime = Date.now();

    for (let index = startIndex; index < uids.length; index++) {
      const importResult = await this._importMessageWithRetry(uids[index], destinationFolderId, folderName);

      if (importResult.skipped) {
        state = this.checkpoint.updateAfterSkip(state);
      } else if (importResult.success) {
        state = this.checkpoint.updateAfterSuccess(state);
      } else {
        state = this.checkpoint.updateAfterFailure(state, uids[index], this._sanitizeError(importResult.error));
      }

      this._saveCheckpointIfDue(folderName, state, index + 1, uids.length);
      this._reportProgressIfDue(index + 1, uids.length, startIndex, folderStartTime, state);
      await new Promise(resolve => setTimeout(resolve, delayMilliseconds));
    }

    return state;
  }

  _saveCheckpointIfDue(folderName, state, messageNumber, totalMessages) {
    if (messageNumber % CHECKPOINT_INTERVAL === 0 || messageNumber === totalMessages) {
      this.checkpoint.save(folderName, state);
    }
  }

  _reportProgressIfDue(messageNumber, totalMessages, startIndex, folderStartTime, state) {
    if (messageNumber % 100 !== 0 && messageNumber !== totalMessages) { return; }

    const elapsed = (Date.now() - folderStartTime) / 1000;
    const processed = messageNumber - startIndex;
    const rate = processed > 0 ? (processed / elapsed).toFixed(1) : '0';
    const remaining = totalMessages - messageNumber;
    const estimatedMinutes = Math.ceil(remaining / (processed / elapsed) / 60);

    const skipInfo = state.skipped > 0 ? `, ${state.skipped} dup` : '';
    console.log(
      `  ${messageNumber}/${totalMessages} — ${state.imported} ok, ${state.failed} fail${skipInfo} (${rate}/s, ~${estimatedMinutes}m remaining)`,
    );
  }

  // ── Single message import with retry ──

  async _importMessageWithRetry(uid, destinationFolderId, folderName) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await this._attemptImport(uid, destinationFolderId);
      } catch (error) {
        lastError = error.message;
        if (attempt < this.maxRetries) {
          await this._backoffAndReconnect(attempt, error, folderName);
        }
      }
    }

    return { success: false, error: `After ${this.maxRetries} attempts: ${lastError}` };
  }

  async _attemptImport(uid, destinationFolderId) {
    const mimeBuffer = await this.source.fetchMessageMime(uid);

    if (!mimeBuffer || mimeBuffer.length === 0) {
      return { success: false, error: 'Empty MIME content' };
    }

    const result = await this.target.importMessage(destinationFolderId, mimeBuffer);

    if (result.success) {
      return { success: true, skipped: result.skipped || false };
    }

    if (this._isPermanentError(result.error)) {
      return { success: false, error: `Permanent: ${result.error}` };
    }

    throw new Error(result.error);
  }

  async _backoffAndReconnect(attempt, error, folderName) {
    const backoffMilliseconds = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 30000);
    await new Promise(resolve => setTimeout(resolve, backoffMilliseconds));

    const isConnectionError = error.message.includes('Not connected') || error.message.includes('ECONNRESET');
    if (isConnectionError) {
      try {
        this.source.disconnect();
        await this.source.connect();
        await this.source.openFolder(folderName);
      } catch (reconnectError) {
        throw new Error(`Reconnect failed: ${reconnectError.message}`);
      }
    }
  }

  _sanitizeError(message) {
    if (!message) { return 'Unknown error'; }
    // Redact potential credentials or tenant-specific info from error messages
    let sanitized = message;
    const tenantId = this.config?.destination?.tenantId;
    const clientId = this.config?.destination?.clientId;
    if (tenantId) { sanitized = sanitized.replaceAll(tenantId, '[tenant-id]'); }
    if (clientId) { sanitized = sanitized.replaceAll(clientId, '[client-id]'); }
    return sanitized;
  }

  _isPermanentError(errorMessage) {
    const permanentPatterns = ['ErrorMessageSizeExceeded', 'ErrorInvalidRecipients', 'ErrorItemCorrupt'];
    return permanentPatterns.some(pattern => errorMessage.includes(pattern));
  }

  // ── Verification ──

  async _compareAllFolders(folders) {
    let totalSource = 0;
    let totalDestination = 0;
    let discrepancies = 0;
    const rows = [];

    for (const folder of folders) {
      const sourceCount = (await this.source.getMessageUids(folder.name)).length;
      const destinationFolderId = await this.target.ensureFolder(folder.name);
      const destinationCount = await this.target.getFolderMessageCount(destinationFolderId);

      totalSource += sourceCount;
      totalDestination += destinationCount;
      const match = sourceCount === destinationCount;
      if (!match) { discrepancies++; }

      rows.push({ name: folder.name, sourceCount, destinationCount, match });
    }

    return { rows, totalSource, totalDestination, discrepancies };
  }

  _printVerificationResults(results) {
    for (const row of results.rows) {
      const indicator = row.match ? '✓' : '✗';
      const mismatchLabel = row.match ? '' : '  ← MISMATCH';
      console.log(
        `  ${indicator} ${row.name.padEnd(35)} source: ${String(row.sourceCount).padStart(6)}  dest: ${String(row.destinationCount).padStart(6)}${mismatchLabel}`,
      );
    }

    console.log(`\n  Total: source=${results.totalSource} dest=${results.totalDestination} discrepancies=${results.discrepancies}`);
    if (results.discrepancies > 0) {
      console.log('\n  Tip: Run "aw2ms365 migrate" again to retry failed messages.');
    }
  }

  // ── Summary ──

  _printBanner(title) {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  aw2ms365 — ${title.padEnd(48)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
  }

  _printSummary() {
    const allStates = this.checkpoint.loadAll();
    const folders = Object.values(allStates);

    let totalImported = 0;
    let totalFailed = 0;
    let totalSkipped = 0;

    this._printBanner('Migration Summary');

    for (const state of folders) {
      const indicator = state.failed > 0 ? '✗' : '✓';
      console.log(`  ${indicator} ${state.folder.padEnd(35)} ${state.imported} imported, ${state.failed} failed`);
      totalImported += state.imported;
      totalFailed += state.failed;
      totalSkipped += state.skipped;
    }

    console.log(`\n  Total: ${totalImported} imported, ${totalFailed} failed, ${totalSkipped} skipped`);

    if (totalFailed > 0) {
      console.log('\n  Failed messages are logged in checkpoint files.');
      console.log('  Run "aw2ms365 migrate" again to retry them.');
    }
  }
}
