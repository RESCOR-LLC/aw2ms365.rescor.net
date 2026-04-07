# Migrating from AWS WorkMail to Microsoft 365

## Why This Guide Exists

In January 2026, Amazon announced that AWS WorkMail would be discontinued. Organizations that relied on WorkMail for email now need to migrate to another provider — often under time pressure and without a clear migration path from AWS.

Microsoft 365 is a common destination. It offers comparable mail, calendar, and directory features, broad client support, and a mature admin ecosystem. But the migration itself is far from straightforward: there is no built-in migration wizard, no export-and-import button, and surprisingly little practical guidance available.

This guide documents what's actually involved, based on first-hand experience migrating a multi-domain organization from WorkMail to MS365. It covers both the manual process and the `aw2ms365` tool we built to automate the hardest part.

## The Big Picture

Migrating email between providers is more than copying messages. A complete migration involves:

1. **Message content** — every email in every folder, for every user
2. **Folder structure** — Inbox, Sent Items, and any custom folders
3. **Email aliases** — alternate addresses that deliver to the same mailbox
4. **Distribution groups** — mailing lists that deliver to multiple users
5. **DNS records** — MX, SPF, DKIM, DMARC, and autodiscover
6. **Client configuration** — Outlook, mobile devices, and any applications that send mail

Getting the messages across is the most time-consuming step, but it's the others that tend to cause problems if overlooked. An alias that doesn't get recreated means bounced mail. A missing SPF record means your messages land in spam. A forgotten distribution group means a team stops receiving updates with no error message to explain why.

## Before You Begin

### Set up your MS365 environment

Before migrating any mail, you need a working MS365 tenant with mailboxes ready to receive:

- **Add your domain(s)** to MS365 via the Admin Center. Microsoft will ask you to add a TXT record to your DNS to prove ownership. Do this first — it doesn't affect mail delivery.
- **Create mailboxes** for each user being migrated. These can be licensed user mailboxes or shared mailboxes (shared mailboxes don't require a license).
- **Don't change your MX records yet.** Keep mail flowing to WorkMail while you migrate. You'll cut over DNS as the final step.

### Inventory what you have on WorkMail

Take stock of everything that needs to move:

- **Users and their email addresses** — including any aliases (alternate addresses that deliver to the same person)
- **Groups** — distribution lists and their members
- **Custom folders** — any folder structure beyond the defaults
- **Approximate mailbox sizes** — large mailboxes (100K+ messages) take significant time to migrate

You can enumerate users, aliases, and groups using the AWS CLI:

```
aws workmail list-users --organization-id m-YOUR_ORG_ID --region us-east-1
aws workmail list-aliases --organization-id m-YOUR_ORG_ID --entity-id USER_SID --region us-east-1
aws workmail list-groups --organization-id m-YOUR_ORG_ID --region us-east-1
```

Write this down. You'll need it later for the manual steps that no tool can automate.

## Migrating Messages

### The manual way

Microsoft offers a built-in IMAP migration feature in Exchange Online. You create a CSV file mapping WorkMail users to MS365 mailboxes, then create a migration batch via PowerShell:

```
New-MigrationBatch -Name "WorkMail" -SourceEndpoint $endpoint -CSVData $csv -AutoStart
```

This works, but has significant limitations:

- **All messages land in the Inbox** regardless of their original folder. Folder structure is not preserved.
- **Transient errors are fatal.** If WorkMail IMAP drops the connection (which it does under sustained load), the migration for that user fails and must be restarted manually.
- **No checkpointing.** A failed migration for a 200,000-message mailbox means starting over from the beginning.
- **Limited visibility.** Progress reporting is minimal, and diagnosing failures requires digging through Exchange migration logs.

For small mailboxes (under 10,000 messages), this approach works fine. For larger mailboxes or organizations with many users, you may want something more resilient.

### Using aw2ms365

The `aw2ms365` tool reads messages directly from WorkMail via IMAP and writes them to MS365 via Exchange Web Services (EWS). It was built specifically to address the limitations above:

- **Folder structure is preserved.** Messages are placed in the correct folder on MS365.
- **Checkpointed and resumable.** Progress is saved every 10 messages. If the process crashes, is interrupted, or loses connectivity, it picks up exactly where it left off.
- **Automatic retry with backoff.** Transient failures (dropped connections, throttling) are retried automatically.
- **Verification built in.** After migration, you can compare message counts between source and destination.

```
npm install -g @rescor/aw2ms365
aw2ms365 init       # interactive setup — saves config to ~/.aw2ms365/
aw2ms365 migrate     # run or resume migration
aw2ms365 verify      # compare source and destination counts
```

See the [README](../README.md) for detailed setup instructions, including the required MS365 app registration.

## After the Messages Are Moved

Message migration is the longest step, but it's not the last. The following must be done manually regardless of which migration method you use.

### Recreate aliases

WorkMail aliases don't transfer to MS365. Every alternate email address that delivers to a user's mailbox needs to be recreated.

This requires Exchange Online PowerShell. For each alias:

```
Set-Mailbox -Identity "user@yourdomain.com" -EmailAddresses @{Add="smtp:alias@yourdomain.com"}
```

If you have many aliases, script this using the inventory you collected earlier. A forgotten alias means bounced mail — and the sender won't know why, because the bounce goes to them, not to you.

### Recreate distribution groups

WorkMail groups are completely separate from MS365 groups. Member lists, group addresses, and delivery rules all need to be recreated manually.

For each group:

```
New-DistributionGroup -Name "Group Name" -PrimarySmtpAddress "group@yourdomain.com" -Members @("user1@yourdomain.com","user2@yourdomain.com")
```

This is easy to overlook. Groups often serve automated systems (alerts, notifications, ticketing) where a silent delivery failure may not be noticed for weeks.

### Update DNS records

Once you've verified that messages, aliases, and groups are all in place on MS365, update your DNS records to route incoming mail to Microsoft instead of WorkMail:

- **MX record** — point to `yourdomain-com.mail.protection.outlook.com`
- **SPF record** — include `spf.protection.outlook.com`
- **DKIM** — add the CNAME records provided by Exchange Admin and enable DKIM signing
- **DMARC** — set your policy (start with `p=none` or `p=quarantine` while monitoring)
- **Autodiscover** — CNAME pointing to `autodiscover.outlook.com`

The `aw2ms365 dns` command will print the specific records for your domain.

**Important:** Do not change MX records until you are confident the migration is complete. Once MX points to MS365, new mail goes there — but if aliases or groups are missing, some of that mail will bounce.

### Update applications and services

Any system that sends email through WorkMail (web applications, monitoring tools, CRM systems, printers, etc.) needs to be reconfigured to use MS365 SMTP or an alternative relay.

MS365 offers several options for application mail:
- **SMTP AUTH** (port 587) for authenticated relay
- **Direct send** to your MX endpoint for internal applications
- **SMTP relay via a connector** for high-volume or multi-tenant scenarios

### Reconfigure mail clients

Most modern mail clients will pick up the new configuration automatically via autodiscover — but only after the autodiscover CNAME is in place. Users on older clients or custom configurations may need manual updates.

## Lessons Learned

These are things we discovered during our own migration that weren't obvious beforehand:

- **Inventory aliases and groups before you start, not after.** It's easy to focus on messages and forget that aliases and groups are separate entities that need explicit migration.
- **Large mailboxes take a long time.** At IMAP speeds, a 200,000-message mailbox takes roughly 55 hours to migrate. Plan accordingly.
- **WorkMail IMAP drops connections under sustained load.** Any migration tool that doesn't handle reconnection will fail on large mailboxes.
- **MS365 anti-spam may quarantine migrated messages.** If you're importing old messages, some may trigger phishing or spam filters. You may need to create transport rules to trust your own domains during migration.
- **EWS-imported messages may have empty envelope fields.** Messages imported via EWS `CreateItem` with raw MIME content are stored correctly, but Exchange doesn't always populate its searchable To/Subject fields from the MIME headers. The message content is intact — it displays correctly when opened — but server-side searching may not find them by recipient.
- **Test with one user first.** Migrate a single mailbox, verify everything (messages, folders, aliases, mail flow), and then proceed with the rest.
- **Don't decommission WorkMail until everything is verified.** WorkMail is your only backup until migration is confirmed complete. Keep it running until you're certain.

## Timeline

A realistic timeline for a small organization (5-10 users, moderate mailbox sizes):

| Phase | Duration | Notes |
|-------|----------|-------|
| MS365 setup and domain verification | 1-2 days | Includes DNS propagation time |
| Message migration | 1-7 days | Depends on mailbox sizes |
| Alias and group recreation | 1-2 hours | Scripted |
| Verification | 1 day | Spot-check messages, test mail flow |
| DNS cutover | 1 day | MX, SPF, DKIM, DMARC, autodiscover |
| Monitoring | 1-2 weeks | Watch for bounces, spam issues, missed aliases |
| WorkMail decommission | After monitoring | Don't rush this |

For larger organizations or mailboxes exceeding 100,000 messages, extend the migration phase accordingly and consider running migrations in parallel for different users.

## Further Reading

- [Microsoft: Migrate other types of IMAP mailboxes to Microsoft 365](https://learn.microsoft.com/en-us/exchange/mailbox-migration/migrating-imap-mailboxes/migrating-imap-mailboxes)
- [AWS WorkMail Administrator Guide](https://docs.aws.amazon.com/workmail/latest/adminguide/what_is.html)
- [Exchange Online PowerShell documentation](https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell)
