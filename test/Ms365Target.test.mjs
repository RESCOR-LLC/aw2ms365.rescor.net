import { describe, it, expect } from 'vitest';
import { Ms365Target } from '../src/Ms365Target.mjs';

// Test internal methods that don't require network access
const target = new Ms365Target({
  destination: {
    tenantId: 'test-tenant',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    mailbox: 'test@example.com',
  },
});

describe('Ms365Target._escapeXml', () => {
  it('escapes ampersands', () => {
    expect(target._escapeXml('a&b')).toBe('a&amp;b');
  });

  it('escapes angle brackets', () => {
    expect(target._escapeXml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes double quotes', () => {
    expect(target._escapeXml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('handles null/undefined', () => {
    expect(target._escapeXml(null)).toBe('');
    expect(target._escapeXml(undefined)).toBe('');
  });

  it('handles combined special characters', () => {
    expect(target._escapeXml('a<b&c>"d')).toBe('a&lt;b&amp;c&gt;&quot;d');
  });
});

describe('Ms365Target._mapToDistinguishedId', () => {
  it('maps inbox case-insensitively', () => {
    expect(target._mapToDistinguishedId('INBOX')).toBe('inbox');
    expect(target._mapToDistinguishedId('Inbox')).toBe('inbox');
    expect(target._mapToDistinguishedId('inbox')).toBe('inbox');
  });

  it('maps sent items', () => {
    expect(target._mapToDistinguishedId('Sent Items')).toBe('sentitems');
    expect(target._mapToDistinguishedId('Sent')).toBe('sentitems');
  });

  it('returns null for unknown folders', () => {
    expect(target._mapToDistinguishedId('My Custom Folder')).toBeNull();
    expect(target._mapToDistinguishedId('')).toBeNull();
  });
});

describe('Ms365Target._extractFingerprint', () => {
  it('extracts subject and date from MIME headers', () => {
    const mime = Buffer.from(
      'Subject: Hello World\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\n\r\nBody',
    );
    const fp = target._extractFingerprint(mime);
    expect(fp.subject).toBe('Hello World');
    expect(fp.date).toBe('Mon, 1 Jan 2024 12:00:00 +0000');
  });

  it('returns null when no headers found', () => {
    const mime = Buffer.from('\r\n\r\nJust a body with no headers');
    const fp = target._extractFingerprint(mime);
    expect(fp).toBeNull();
  });

  it('handles MIME-encoded subjects', () => {
    const mime = Buffer.from(
      'Subject: =?UTF-8?B?SGVsbG8gV29ybGQ=?=\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\n\r\nBody',
    );
    const fp = target._extractFingerprint(mime);
    expect(fp.subject).toBe('Hello World');
  });

  it('handles Q-encoded subjects with non-ASCII replaced', () => {
    const mime = Buffer.from(
      'Subject: =?windows-1252?Q?You=92re_in?=\r\nDate: Mon, 1 Jan 2024 12:00:00 +0000\r\n\r\nBody',
    );
    const fp = target._extractFingerprint(mime);
    expect(fp.subject).toContain('You');
    expect(fp.subject).toContain('re');
  });
});

describe('Ms365Target._decodeMimeHeader', () => {
  it('decodes Base64 encoded words', () => {
    const result = target._decodeMimeHeader('=?UTF-8?B?SGVsbG8=?= World');
    expect(result).toBe('Hello World');
  });

  it('decodes Q-encoded words', () => {
    const result = target._decodeMimeHeader('=?UTF-8?Q?Hello_World?=');
    expect(result).toBe('Hello World');
  });

  it('replaces non-ASCII in Q-encoded with spaces', () => {
    const result = target._decodeMimeHeader('=?windows-1252?Q?You=92re?=');
    expect(result).toContain('You');
    expect(result).toContain('re');
  });

  it('passes through plain text unchanged', () => {
    expect(target._decodeMimeHeader('Just plain text')).toBe('Just plain text');
  });
});

describe('Ms365Target._extractHeader', () => {
  it('extracts a header by name', () => {
    const headers = 'From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: Test';
    expect(target._extractHeader(headers, 'Subject')).toBe('Test');
    expect(target._extractHeader(headers, 'From')).toBe('sender@example.com');
  });

  it('is case-insensitive', () => {
    const headers = 'subject: Test Subject\r\n';
    expect(target._extractHeader(headers, 'Subject')).toBe('Test Subject');
  });

  it('returns null for missing headers', () => {
    const headers = 'From: sender@example.com\r\n';
    expect(target._extractHeader(headers, 'Subject')).toBeNull();
  });
});

describe('Ms365Target constructor security', () => {
  it('escapes mailbox for XML safety', () => {
    const malicious = new Ms365Target({
      destination: {
        tenantId: 't', clientId: 'c', clientSecret: 's',
        mailbox: 'user@example.com</t:SmtpAddress><evil/>',
      },
    });
    expect(malicious.escapedMailbox).not.toContain('<evil');
    expect(malicious.escapedMailbox).toContain('&lt;evil');
  });
});
