# aw2ms365

Migrate mailboxes from AWS WorkMail to Microsoft 365.

Resilient, checkpointed, resumable. Reads from WorkMail via IMAP, writes to MS365 via EWS. Preserves folder structure and message fidelity.

## Who This Is For - PLEASE DO NOT SKIP THIS SECTION!

This tool is designed for **IT administrators and technically proficient users** who are comfortable working in a terminal. While the migration itself is largely automated, setup and troubleshooting require familiarity with:

- **Command line basics** — running commands, editing config files, reading error output
- **AWS WorkMail** — knowing your IMAP credentials and (for alias/group discovery) the AWS CLI
- **Microsoft 365 / Entra ID** — registering an app, granting API permissions, and basic Exchange Online concepts
- **PowerShell** (optional) — needed only for post-migration tasks like recreating aliases and distribution groups
- **DNS** (optional) — understanding MX, SPF, DKIM, and DMARC records if you are also cutting over mail delivery

If terms like "OAuth client credentials," "IMAP," and "EWS" are unfamiliar, you may want to enlist help from someone with email administration experience.

## External Dependencies

### Required

- **[Node.js](https://nodejs.org/) v20 or later** — the runtime for this tool. Download from nodejs.org or install via your OS package manager.

### Optional (for post-migration tasks)

- **[AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)** — needed to list WorkMail aliases and groups before migration. Not required for the migration itself.
  ```bash
  aws --version   # verify installation
  ```

- **[PowerShell 7+](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell)** with the **[Exchange Online Management module](https://www.powershellgallery.com/packages/ExchangeOnlineManagement)** — needed to recreate aliases and distribution groups on MS365 after migration. Not required for the migration itself.
  ```bash
  pwsh --version                                    # verify PowerShell
  pwsh -Command "Get-Module -ListAvailable ExchangeOnlineManagement"  # verify module
  ```
  Install the module if missing:
  ```powershell
  Install-Module -Name ExchangeOnlineManagement -Force
  ```

## Quick Start

```bash
# Install
npm install -g @rescor/aw2ms365

# Interactive setup — prompts for credentials, saves to ~/.aw2ms365/
aw2ms365 init

# Run migration
aw2ms365 migrate
```

All data is stored in `~/.aw2ms365/` — config, checkpoints, and logs never end up in a git repo.

## Features

- **Folder preservation** — recreates your WorkMail folder structure in MS365
- **Crash recovery** — checkpoints every 10 messages; resume exactly where you left off
- **Retry with backoff** — transient failures retry 3x with exponential backoff and jitter
- **IMAP reconnect** — automatically reconnects if the WorkMail IMAP connection drops
- **Rate limiting** — configurable rate limit (default 1 msg/s) to avoid EWS throttling
- **Verification** — compare source/destination message counts after migration
- **DNS advisory** — prints the DNS records you need for MS365 mail
- **Cross-platform** — runs on macOS, Linux, Windows (Node.js 20+)

## Prerequisites

### 1. WorkMail Credentials

You need your WorkMail username and password. Your IMAP server is typically:
```
imap.mail.us-east-1.awsapps.com
```

### 2. MS365 App Registration

The tool uses EWS (Exchange Web Services) with OAuth2 client credentials. You need to register an app in Azure/Entra ID:

1. Go to [Entra ID → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
   - Name: `aw2ms365` (or whatever you prefer)
   - Supported account types: **Single tenant**
   - Redirect URI: leave blank
3. Note the **Application (client) ID** and **Directory (tenant) ID**
4. Go to **Certificates & secrets** → **New client secret** → copy the value
5. Go to **API permissions** → **Add a permission**
   - Select **APIs my organization uses**
   - Search for **Office 365 Exchange Online**
   - Select **Application permissions**
   - Add **full_access_as_app**
   - Click **Grant admin consent**

The app needs the `full_access_as_app` permission to impersonate the target mailbox via EWS. This is an admin-level permission — an MS365 administrator must grant consent.

### 3. MS365 Mailbox

The destination mailbox must already exist in MS365. Create it via the MS365 Admin Center or PowerShell before running the migration.

## Commands

### `aw2ms365 init`

Interactive setup — prompts for WorkMail and MS365 credentials, saves config to `~/.aw2ms365/config.yaml`. Use `--non-interactive` to generate a template for manual editing.

### `aw2ms365 migrate [config.yaml]`

Runs the migration. Safe to run multiple times — it resumes from the last checkpoint. Config defaults to `~/.aw2ms365/config.yaml` if not specified.

### `aw2ms365 status [config.yaml]`

Shows migration progress from checkpoint files.

### `aw2ms365 verify [config.yaml]`

Connects to both WorkMail and MS365 and compares message counts per folder.

### `aw2ms365 dns [config.yaml]`

Prints the DNS records (MX, SPF, DKIM, DMARC, autodiscover) you need to configure for MS365 mail delivery on your domain.

## Configuration

```yaml
source:
  host: imap.mail.us-east-1.awsapps.com
  port: 993
  tls: true
  user: you@yourdomain.com
  password: your-workmail-password

destination:
  tenantId: your-azure-tenant-id
  clientId: your-app-client-id
  clientSecret: your-app-client-secret
  mailbox: you@yourdomain.com

options:
  skipFolders:
    - Deleted Items
    - Junk Email
    - Drafts
  rateLimit: 1                    # messages per second
  maxRetries: 3                   # retries per failed message
  checkpointDirectory: ~/.aw2ms365/checkpoints
```

## How It Works

1. **Connect** to WorkMail IMAP and authenticate with MS365 OAuth2
2. **Discover** folders on WorkMail, skip configured exclusions
3. **For each folder:**
   - List all message UIDs
   - Load checkpoint (skip already-migrated messages)
   - Fetch each message as raw RFC 822 MIME from IMAP
   - Import into MS365 via EWS `CreateItem` with `MimeContent`
   - Checkpoint progress every 10 messages
4. **Report** per-folder and overall results

Messages are imported with `IsRead=true` to avoid flooding the user's notification count with old mail.

## Checkpoint Files

Progress is saved in the checkpoint directory (default `~/.aw2ms365/checkpoints/`) as JSON files, one per folder. Each file tracks:

- Total UIDs in the folder
- Last successfully processed index
- Counts of imported / failed / skipped messages
- List of failed UIDs with error messages and timestamps

If the process crashes or is interrupted, running `aw2ms365 migrate` again picks up exactly where it left off.

## Troubleshooting

### "OAuth error: AADSTS7000215"
The app registration doesn't have admin consent. An MS365 admin needs to grant consent for the `full_access_as_app` permission.

### "401 Unauthorized" on EWS
The client secret may have expired. Generate a new one in Entra ID → App registrations → Certificates & secrets.

### High failure rate
Increase the rate limit interval or reduce concurrent load. EWS throttles at approximately 2,000 requests per minute per mailbox.

### "ECONNRESET" or "Not connected"
WorkMail IMAP dropped the connection. The tool automatically reconnects and retries.

### Messages appear but have empty To/Subject fields
This is a known EWS limitation: `CreateItem` with `MimeContent` stores the raw MIME but doesn't always populate Exchange's searchable envelope properties. The message content is intact — Outlook will display it correctly when opened.

## What This Tool Does NOT Migrate

This tool migrates **message content and folder structure only**. The following must be handled manually:

### Email Aliases

WorkMail aliases (e.g., `alias@yourdomain.com` → `user@yourdomain.com`) are not migrated. Aliases must be recreated in MS365 via Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline -UserPrincipalName admin@yourdomain.com
Set-Mailbox -Identity "you@yourdomain.com" -EmailAddresses @{Add="smtp:alias@yourdomain.com"}
Disconnect-ExchangeOnline -Confirm:$false
```

To list your existing WorkMail aliases, use the AWS CLI:
```bash
aws workmail list-aliases --organization-id m-YOUR_ORG_ID --entity-id YOUR_USER_SID --region us-east-1
```

### Distribution Groups

WorkMail groups (mailing lists like `example@yourdomain.com`) are not migrated. Group membership information will be lost unless you recreate the groups manually in MS365:

```powershell
Connect-ExchangeOnline -UserPrincipalName admin@yourdomain.com
New-DistributionGroup -Name "Example" -PrimarySmtpAddress "example@yourdomain.com" -Members @("user1@yourdomain.com","user2@yourdomain.com")
Disconnect-ExchangeOnline -Confirm:$false
```

To list your existing WorkMail groups and their members:
```bash
aws workmail list-groups --organization-id m-YOUR_ORG_ID --region us-east-1
aws workmail list-group-members --organization-id m-YOUR_ORG_ID --group-id GROUP_SID --region us-east-1
```

### Other Items Not Migrated

- **Contacts** — personal contacts are not stored in IMAP mail folders
- **Calendar entries** — stored separately from mail in WorkMail
- **Rules/filters** — WorkMail inbox rules do not transfer to MS365
- **Signatures** — must be recreated in Outlook/MS365

## Data Directory

All aw2ms365 data is stored in `~/.aw2ms365/`:

```
~/.aw2ms365/
├── config.yaml      # credentials and settings
├── checkpoints/     # per-folder resume state (JSON)
└── logs/            # migration logs
```

This keeps credentials out of project directories and git repos. The directory is created automatically on first run.

You can override the config path with an explicit argument: `aw2ms365 migrate /other/config.yaml`

## Security Notes

- **Do not delete messages or mailboxes on AWS WorkMail until you have verified the migration to your satisfaction.** Use `aw2ms365 verify` to compare message counts, and spot-check important folders manually. WorkMail is your only source of truth until you are confident the migration is complete.
- **Do not decommission your WorkMail organization until aliases, groups, and DNS have been fully migrated.** Message content is only part of a working mail system.
- **Credentials are stored in `~/.aw2ms365/config.yaml`** — never in your project directory.
- The MS365 app secret should be rotated after migration is complete.
- Consider deleting the app registration entirely once migration is done.
- WorkMail credentials are sent over TLS (IMAP port 993).

## Migration Guide

For a comprehensive walkthrough of the entire WorkMail-to-MS365 migration process — including the manual steps outside the scope of this tool — see [docs/migration-guide.md](docs/migration-guide.md).

## License

MIT
