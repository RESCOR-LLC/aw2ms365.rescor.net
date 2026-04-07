/**
 * DnsAdvisor — prints the DNS records needed for MS365 mail on a domain.
 * Advisory only — does not modify DNS.
 */

export class DnsAdvisor {

  constructor(config) {
    this.mailbox = config.destination.mailbox;
    this.domain = this.mailbox.split('@')[1];
  }

  printRecords() {
    const domain = this.domain;
    const encodedDomain = domain.replace(/\./g, '-');

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Required DNS Records for Microsoft 365                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    console.log(`  Domain: ${domain}\n`);
    console.log('  Add these records at your DNS provider:\n');

    console.log('  ── MX (Mail Exchange) ──');
    console.log(`  Type: MX`);
    console.log(`  Name: @`);
    console.log(`  Value: ${encodedDomain}.mail.protection.outlook.com`);
    console.log(`  Priority: 0`);
    console.log(`  TTL: 3600\n`);

    console.log('  ── SPF (Sender Policy Framework) ──');
    console.log(`  Type: TXT`);
    console.log(`  Name: @`);
    console.log(`  Value: v=spf1 include:spf.protection.outlook.com ~all`);
    console.log(`  TTL: 3600\n`);

    console.log('  ── DKIM (DomainKeys Identified Mail) ──');
    console.log(`  Type: CNAME`);
    console.log(`  Name: selector1._domainkey`);
    console.log(`  Value: selector1-${encodedDomain}._domainkey.<your-tenant>.onmicrosoft.com`);
    console.log(`  TTL: 3600\n`);
    console.log(`  Type: CNAME`);
    console.log(`  Name: selector2._domainkey`);
    console.log(`  Value: selector2-${encodedDomain}._domainkey.<your-tenant>.onmicrosoft.com`);
    console.log(`  TTL: 3600\n`);
    console.log(`  Note: Replace <your-tenant> with your MS365 tenant name.`);
    console.log(`  The exact CNAME targets are shown in Exchange Admin → DKIM after`);
    console.log(`  running: New-DkimSigningConfig -DomainName ${domain} -Enabled $true\n`);

    console.log('  ── DMARC ──');
    console.log(`  Type: TXT`);
    console.log(`  Name: _dmarc`);
    console.log(`  Value: v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}; pct=100; fo=1`);
    console.log(`  TTL: 3600\n`);

    console.log('  ── Autodiscover ──');
    console.log(`  Type: CNAME`);
    console.log(`  Name: autodiscover`);
    console.log(`  Value: autodiscover.outlook.com`);
    console.log(`  TTL: 3600\n`);

    console.log('  ── Order of Operations ──');
    console.log('  1. Verify domain in MS365 Admin Center (adds TXT verification record)');
    console.log('  2. Add autodiscover CNAME');
    console.log('  3. Run migration (aw2ms365 migrate)');
    console.log('  4. After migration verified, switch MX record to MS365');
    console.log('  5. Add SPF, DKIM, DMARC records');
    console.log('  6. Enable DKIM signing in Exchange Admin');
    console.log('  7. Decommission WorkMail');
  }
}
