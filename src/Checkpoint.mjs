/**
 * Checkpoint — persists migration progress to disk for crash recovery.
 *
 * State is saved per-folder as a JSON file containing:
 *   - folder name
 *   - total UIDs
 *   - last successfully migrated UID
 *   - count of imported / failed / skipped messages
 *   - list of failed UIDs with error messages
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class Checkpoint {

  constructor(directory) {
    this.directory = directory;
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  }

  _filePathForFolder(folderName) {
    const safeName = folderName.replace(/[/\\:*?"<>|]/g, '_');
    return join(this.directory, `${safeName}.json`);
  }

  load(folderName) {
    const filePath = this._filePathForFolder(folderName);
    if (!existsSync(filePath)) {
      return null;
    }
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  }

  save(folderName, state) {
    const filePath = this._filePathForFolder(folderName);
    writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  loadAll() {
    const states = {};
    const files = readdirSync(this.directory).filter(file => file.endsWith('.json'));
    for (const file of files) {
      const content = readFileSync(join(this.directory, file), 'utf-8');
      const state = JSON.parse(content);
      states[state.folder] = state;
    }
    return states;
  }

  createInitialState(folderName, totalUids) {
    return {
      folder: folderName,
      totalUids,
      lastCompletedIndex: -1,
      imported: 0,
      failed: 0,
      skipped: 0,
      failures: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  updateAfterSuccess(state) {
    state.lastCompletedIndex++;
    state.imported++;
    state.updatedAt = new Date().toISOString();
    return state;
  }

  updateAfterFailure(state, uid, errorMessage) {
    state.lastCompletedIndex++;
    state.failed++;
    state.failures.push({ uid, error: errorMessage, timestamp: new Date().toISOString() });
    state.updatedAt = new Date().toISOString();
    return state;
  }

  updateAfterSkip(state) {
    state.lastCompletedIndex++;
    state.skipped++;
    state.updatedAt = new Date().toISOString();
    return state;
  }
}
