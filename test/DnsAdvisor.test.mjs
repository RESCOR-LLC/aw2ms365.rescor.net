import { describe, it, expect } from 'vitest';
import { DnsAdvisor } from '../src/DnsAdvisor.mjs';

describe('DnsAdvisor', () => {
  it('extracts domain from mailbox address', () => {
    const advisor = new DnsAdvisor({
      destination: { mailbox: 'user@example.com' },
    });
    expect(advisor.domain).toBe('example.com');
  });

  it('prints records without errors', () => {
    const advisor = new DnsAdvisor({
      destination: { mailbox: 'user@test-domain.org' },
    });
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    advisor.printRecords();
    console.log = originalLog;

    const output = logs.join('\n');
    expect(output).toContain('test-domain.org');
    expect(output).toContain('MX');
    expect(output).toContain('SPF');
    expect(output).toContain('DKIM');
    expect(output).toContain('DMARC');
    expect(output).toContain('autodiscover');
    expect(output).toContain('test-domain-org.mail.protection.outlook.com');
  });

  it('encodes dots as dashes in MX hostname', () => {
    const advisor = new DnsAdvisor({
      destination: { mailbox: 'user@sub.example.com' },
    });
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));
    advisor.printRecords();
    console.log = originalLog;

    const output = logs.join('\n');
    expect(output).toContain('sub-example-com.mail.protection.outlook.com');
  });
});
