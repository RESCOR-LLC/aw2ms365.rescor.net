#!/usr/bin/env node
/**
 * aw2ms365 — Migrate a mailbox from AWS WorkMail to Microsoft 365.
 *
 * Usage:
 *   aw2ms365 init                      Set up config interactively
 *   aw2ms365 migrate [config.yaml]     Run or resume a migration
 *   aw2ms365 status  [config.yaml]     Show migration progress
 *   aw2ms365 verify  [config.yaml]     Compare source/destination counts
 *   aw2ms365 dns     [config.yaml]     Print required DNS records
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { MigrationEngine } from '../src/MigrationEngine.mjs';
import { StatusReporter } from '../src/StatusReporter.mjs';
import { DnsAdvisor } from '../src/DnsAdvisor.mjs';

const APP_HOME = join(homedir(), '.aw2ms365');
const DEFAULT_CONFIG = join(APP_HOME, 'config.yaml');
const DEFAULT_CHECKPOINTS = join(APP_HOME, 'checkpoints');
const DEFAULT_LOGS = join(APP_HOME, 'logs');

const SAMPLE_CONFIG = `# aw2ms365 — Migration Configuration
#
# Fill in your WorkMail and MS365 credentials, then run:
#   npx aw2ms365 migrate

source:
  # WorkMail IMAP settings
  host: imap.mail.us-east-1.awsapps.com
  port: 993
  tls: true
  user: you@yourdomain.com
  password: your-workmail-password

destination:
  # MS365 EWS settings (requires app registration — see README)
  tenantId: your-tenant-id
  clientId: your-app-client-id
  clientSecret: your-app-client-secret
  # The mailbox to import into
  mailbox: you@yourdomain.com

options:
  # Folders to skip (case-insensitive)
  skipFolders:
    - Deleted Items
    - Junk Email
    - Drafts
  # Messages per second (avoid throttling)
  rateLimit: 1
  # Max retries per message before marking as failed
  maxRetries: 3
  # Checkpoint directory (for resume support)
  checkpointDirectory: ${DEFAULT_CHECKPOINTS}
`;

// ── Helpers ──

function ensureAppHome() {
  for (const directory of [APP_HOME, DEFAULT_CHECKPOINTS, DEFAULT_LOGS]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
  }
}

function loadConfig(configPath) {
  const configFile = resolve(configPath || DEFAULT_CONFIG);
  if (!existsSync(configFile)) {
    const message = configPath
      ? `Config file not found: ${configFile}`
      : `No config file found at ${configFile}\nRun "aw2ms365 init" to create one.`;
    console.error(message);
    process.exit(1);
  }
  return yaml.load(readFileSync(configFile, 'utf-8'));
}

function createReadlinePrompt() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (question, defaultValue) => new Promise(resolve => {
    const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    readline.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });

  const askPassword = (question) => new Promise(resolve => {
    process.stdout.write(`${question}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) { stdin.setRawMode(true); }
    stdin.resume();
    let password = '';
    const onData = (chunk) => {
      const character = chunk.toString();
      if (character === '\n' || character === '\r') {
        stdin.removeListener('data', onData);
        if (stdin.isTTY) { stdin.setRawMode(wasRaw); }
        process.stdout.write('\n');
        resolve(password);
      } else if (character === '\x7f' || character === '\b') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (character === '\x03') {
        process.exit(0);
      } else {
        password += character;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });

  return { readline, ask, askPassword };
}

async function promptSourceConfig(ask, askPassword) {
  console.log('  Source: AWS WorkMail (IMAP)\n');
  const host = await ask('  IMAP server', 'imap.mail.us-east-1.awsapps.com');
  const port = await ask('  IMAP port', '993');
  const user = await ask('  WorkMail email address');
  const password = await askPassword('  WorkMail password');
  return { host, port: parseInt(port, 10), tls: true, user, password };
}

async function promptDestinationConfig(ask, askPassword, defaultMailbox) {
  console.log('\n  Destination: Microsoft 365 (EWS)\n');
  console.log('  You need an Entra ID app registration with full_access_as_app.');
  console.log('  See README.md for setup instructions.\n');
  const tenantId = await ask('  MS365 Tenant ID');
  const clientId = await ask('  App Client ID');
  const clientSecret = await askPassword('  App Client Secret');
  const mailbox = await ask('  Destination mailbox address', defaultMailbox);
  return { tenantId, clientId, clientSecret, mailbox };
}

async function promptOptions(ask) {
  console.log('\n  Options\n');
  const skipInput = await ask('  Folders to skip (comma-separated)', 'Deleted Items, Junk Email, Drafts');
  const rateLimit = await ask('  Messages per second', '1');
  const checkpointDirectory = await ask('  Checkpoint directory', DEFAULT_CHECKPOINTS);
  const skipFolders = skipInput.split(',').map(folder => folder.trim()).filter(Boolean);
  return { skipFolders, rateLimit: parseInt(rateLimit, 10), maxRetries: 3, checkpointDirectory };
}

// ── Commands ──

function printHelp() {
  console.log(`
  aw2ms365 — AWS WorkMail to Microsoft 365 Migration Tool

  Commands:
    init                      Set up config interactively (saved to ~/.aw2ms365/)
    migrate [config.yaml]     Run or resume a migration
    status  [config.yaml]     Show migration progress
    verify  [config.yaml]     Compare source/destination message counts
    dns     [config.yaml]     Print required DNS records for your domain

  Config file defaults to ~/.aw2ms365/config.yaml if not specified.

  Examples:
    aw2ms365 init                        # Interactive config setup
    aw2ms365 init --non-interactive      # Generate template to edit manually
    aw2ms365 migrate                     # Start/resume (uses default config)
    aw2ms365 migrate ~/other/config.yaml # Start/resume with explicit config
    aw2ms365 status                      # Check progress
    aw2ms365 verify                      # Verify completeness
    aw2ms365 dns                         # Show DNS records needed

  Data directory: ~/.aw2ms365/
    config.yaml    — credentials and settings
    checkpoints/   — per-folder resume state
    logs/          — migration logs
  `);
}

async function runInit(targetPath) {
  ensureAppHome();

  if (existsSync(targetPath)) {
    console.error(`File "${targetPath}" already exists. Remove it first or specify a different name.`);
    process.exit(1);
  }

  if (process.argv.includes('--non-interactive')) {
    writeFileSync(targetPath, SAMPLE_CONFIG);
    console.log(`Created ${targetPath} — edit it with your credentials and run: aw2ms365 migrate`);
    process.exit(0);
  }

  const { readline, ask, askPassword } = createReadlinePrompt();

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  aw2ms365 — Configuration Setup                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const source = await promptSourceConfig(ask, askPassword);
  const destination = await promptDestinationConfig(ask, askPassword, source.user);
  const options = await promptOptions(ask);

  readline.close();

  const configObject = { source, destination, options };
  writeFileSync(targetPath, yaml.dump(configObject, { lineWidth: 120 }));
  console.log(`\n  Config written to ${targetPath}`);
  console.log(`  Run: aw2ms365 migrate\n`);
}

// ── Main ──

const [,, command, configPath] = process.argv;

if (!command || command === '--help' || command === '-h') {
  printHelp();
  process.exit(0);
}

if (command === 'init') {
  await runInit(configPath || DEFAULT_CONFIG);
  process.exit(0);
}

const config = loadConfig(configPath);

if (command === 'dns') {
  new DnsAdvisor(config).printRecords();
} else if (command === 'status') {
  new StatusReporter(config).printStatus();
} else if (command === 'migrate') {
  await new MigrationEngine(config).run();
} else if (command === 'verify') {
  await new MigrationEngine(config).verify();
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
