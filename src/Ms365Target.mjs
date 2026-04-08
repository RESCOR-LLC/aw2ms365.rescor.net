/**
 * MS365 EWS target — authenticates via OAuth2 client credentials,
 * creates folders, and imports messages via EWS CreateItem with MimeContent.
 */

const EWS_URL = 'https://outlook.office365.com/EWS/Exchange.asmx';

export class Ms365Target {

  constructor(config) {
    this.tenantId = config.destination.tenantId;
    this.clientId = config.destination.clientId;
    this.clientSecret = config.destination.clientSecret;
    this.mailbox = config.destination.mailbox;
    this.token = null;
    this.tokenExpiry = 0;
    this.folderIdCache = new Map();
  }

  async authenticate() {
    await this._refreshToken();
    return this;
  }

  async _refreshToken() {
    const parameters = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: 'https://outlook.office365.com/.default',
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
      { method: 'POST', body: parameters },
    );
    const tokenData = await response.json();

    if (tokenData.error) {
      throw new Error(`OAuth error: ${tokenData.error_description}`);
    }

    this.token = tokenData.access_token;
    this.tokenExpiry = Date.now() + 3500000; // ~58 min
  }

  async _ensureToken() {
    if (Date.now() > this.tokenExpiry) {
      await this._refreshToken();
    }
  }

  async _ewsRequest(soapBody) {
    await this._ensureToken();

    const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
               xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Header>
    <t:RequestServerVersion Version="Exchange2016"/>
    <t:ExchangeImpersonation>
      <t:ConnectingSID>
        <t:SmtpAddress>${this.mailbox}</t:SmtpAddress>
      </t:ConnectingSID>
    </t:ExchangeImpersonation>
  </soap:Header>
  <soap:Body>${soapBody}</soap:Body>
</soap:Envelope>`;

    const response = await fetch(EWS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'text/xml; charset=utf-8',
      },
      body: envelope,
    });

    return response.text();
  }

  async ensureFolder(folderPath) {
    if (this.folderIdCache.has(folderPath)) {
      return this.folderIdCache.get(folderPath);
    }

    const segments = folderPath.split('/');
    let parentId = null;
    let parentIsDistinguished = true;
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const resolved = await this._resolveSegment(segment, currentPath, parentId, parentIsDistinguished);
      parentId = resolved.folderId;
      parentIsDistinguished = false;
    }

    return parentId;
  }

  async _resolveSegment(segment, currentPath, parentId, parentIsDistinguished) {
    if (this.folderIdCache.has(currentPath)) {
      return { folderId: this.folderIdCache.get(currentPath) };
    }

    // Check for well-known folder at root level
    const distinguishedName = this._mapToDistinguishedId(segment);
    if (parentId === null && distinguishedName) {
      const folderId = await this._findDistinguishedFolder(distinguishedName);
      if (folderId) {
        this.folderIdCache.set(currentPath, folderId);
        return { folderId };
      }
    }

    // Find or create
    const folderId = await this._findOrCreateFolder(segment, parentId, parentIsDistinguished);
    if (!folderId) {
      throw new Error(`Failed to create or find folder: ${currentPath}`);
    }

    this.folderIdCache.set(currentPath, folderId);
    return { folderId };
  }

  async _findOrCreateFolder(displayName, parentId, parentIsDistinguished) {
    const folderId = await this._findFolderByName(displayName, parentId, parentIsDistinguished);
    if (folderId) { return folderId; }
    return this._createFolder(displayName, parentId, parentIsDistinguished);
  }

  _mapToDistinguishedId(folderName) {
    const mapping = {
      'inbox': 'inbox',
      'sent items': 'sentitems',
      'sent': 'sentitems',
      'drafts': 'drafts',
      'deleted items': 'deleteditems',
      'junk email': 'junkemail',
      'junk': 'junkemail',
      'archive': 'archive',
      'outbox': 'outbox',
    };
    return mapping[folderName.toLowerCase()] || null;
  }

  async _findDistinguishedFolder(distinguishedId) {
    const xml = await this._ewsRequest(`
      <m:GetFolder>
        <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
        <m:FolderIds>
          <t:DistinguishedFolderId Id="${distinguishedId}"/>
        </m:FolderIds>
      </m:GetFolder>`);

    const match = xml.match(/FolderId Id="([^"]+)"/);
    return match ? match[1] : null;
  }

  async _findFolderByName(displayName, parentId, parentIsDistinguished) {
    const parentXml = parentId === null || parentIsDistinguished
      ? `<t:DistinguishedFolderId Id="${parentId || 'msgfolderroot'}"/>`
      : `<t:FolderId Id="${parentId}"/>`;

    const escapedName = displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    const xml = await this._ewsRequest(`
      <m:FindFolder Traversal="Shallow">
        <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
        <m:Restriction>
          <t:IsEqualTo>
            <t:FieldURI FieldURI="folder:DisplayName"/>
            <t:FieldURIOrConstant>
              <t:Constant Value="${escapedName}"/>
            </t:FieldURIOrConstant>
          </t:IsEqualTo>
        </m:Restriction>
        <m:ParentFolderIds>${parentXml}</m:ParentFolderIds>
      </m:FindFolder>`);

    const match = xml.match(/FolderId Id="([^"]+)"/);
    return match ? match[1] : null;
  }

  async _createFolder(displayName, parentId, parentIsDistinguished) {
    const parentXml = parentId === null || parentIsDistinguished
      ? `<t:DistinguishedFolderId Id="${parentId || 'msgfolderroot'}"/>`
      : `<t:FolderId Id="${parentId}"/>`;

    const escapedName = displayName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    const xml = await this._ewsRequest(`
      <m:CreateFolder>
        <m:ParentFolderId>${parentXml}</m:ParentFolderId>
        <m:Folders>
          <t:Folder>
            <t:DisplayName>${escapedName}</t:DisplayName>
          </t:Folder>
        </m:Folders>
      </m:CreateFolder>`);

    const match = xml.match(/FolderId Id="([^"]+)"/);
    return match ? match[1] : null;
  }

  async importMessage(folderId, mimeBuffer) {
    const fingerprint = this._extractFingerprint(mimeBuffer);

    if (fingerprint) {
      const isDuplicate = await this._messageExistsInFolder(folderId, fingerprint);
      if (isDuplicate) {
        return { success: true, skipped: true };
      }
    }

    return this._createMessage(folderId, mimeBuffer);
  }

  _extractFingerprint(mimeBuffer) {
    const headerEnd = mimeBuffer.indexOf('\r\n\r\n');
    const headerBytes = headerEnd > 0 ? mimeBuffer.subarray(0, Math.min(headerEnd, 16384)) : mimeBuffer.subarray(0, 16384);
    const headerText = headerBytes.toString('utf-8');

    const subject = this._extractHeader(headerText, 'Subject');
    const from = this._extractHeader(headerText, 'From');
    const date = this._extractHeader(headerText, 'Date');

    if (!subject && !from && !date) { return null; }
    return { subject, from, date };
  }

  _extractHeader(headerText, headerName) {
    const regex = new RegExp(`^${headerName}:\\s*(.+)`, 'mi');
    const match = headerText.match(regex);
    if (!match) { return null; }
    let value = match[1].trim();
    value = this._decodeMimeHeader(value);
    return value;
  }

  _decodeMimeHeader(value) {
    // Decode RFC 2047 MIME encoded-words: =?charset?encoding?text?=
    return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (match, charset, encoding, text) => {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString('utf-8');
      }
      // Q encoding: underscores are spaces, =XX is hex
      // Strip non-ASCII results — they may be wrong charset. The substring
      // search will still match on the ASCII portions.
      const decoded = text
        .replace(/_/g, ' ')
        .replace(/=([0-9A-Fa-f]{2})/g, (m, hex) => {
          const code = parseInt(hex, 16);
          return code < 128 ? String.fromCharCode(code) : ' ';
        });
      return decoded;
    });
  }

  async _messageExistsInFolder(folderId, fingerprint) {
    if (!fingerprint.subject || fingerprint.subject.length < 5) { return false; }

    // Use the longest ASCII word from the subject — avoids encoding
    // mismatches (smart quotes, em dashes, charset differences between
    // MIME source and Exchange's decoded storage)
    const words = fingerprint.subject.match(/[a-zA-Z0-9]{3,}/g);
    if (!words || words.length === 0) { return false; }
    const searchWord = words.sort((a, b) => b.length - a.length)[0];
    const escaped = searchWord.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    const subjectRestriction = `
      <t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">
        <t:FieldURI FieldURI="item:Subject"/>
        <t:Constant Value="${escaped}"/>
      </t:Contains>`;

    let restriction = subjectRestriction;

    // Add date window if available — narrows false positives from common words
    if (fingerprint.date) {
      const parsedDate = new Date(fingerprint.date);
      if (!isNaN(parsedDate.getTime())) {
        const beforeDate = new Date(parsedDate.getTime() - 300000).toISOString();
        const afterDate = new Date(parsedDate.getTime() + 300000).toISOString();
        restriction = `
          <t:And>
            ${subjectRestriction}
            <t:IsGreaterThanOrEqualTo>
              <t:FieldURI FieldURI="item:DateTimeSent"/>
              <t:FieldURIOrConstant><t:Constant Value="${beforeDate}"/></t:FieldURIOrConstant>
            </t:IsGreaterThanOrEqualTo>
            <t:IsLessThanOrEqualTo>
              <t:FieldURI FieldURI="item:DateTimeSent"/>
              <t:FieldURIOrConstant><t:Constant Value="${afterDate}"/></t:FieldURIOrConstant>
            </t:IsLessThanOrEqualTo>
          </t:And>`;
      }
    }

    const xml = await this._ewsRequest(`
      <m:FindItem Traversal="Shallow">
        <m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>
        <m:IndexedPageItemView MaxEntriesReturned="1" Offset="0" BasePoint="Beginning"/>
        <m:Restriction>${restriction}</m:Restriction>
        <m:ParentFolderIds><t:FolderId Id="${folderId}"/></m:ParentFolderIds>
      </m:FindItem>`);
    return xml.includes('ItemId Id="');
  }

  async _createMessage(folderId, mimeBuffer) {
    const mimeBase64 = mimeBuffer.toString('base64');

    const xml = await this._ewsRequest(`
      <m:CreateItem MessageDisposition="SaveOnly">
        <m:SavedItemFolderId>
          <t:FolderId Id="${folderId}"/>
        </m:SavedItemFolderId>
        <m:Items>
          <t:Message>
            <t:MimeContent CharacterSet="UTF-8">${mimeBase64}</t:MimeContent>
            <t:IsRead>true</t:IsRead>
          </t:Message>
        </m:Items>
      </m:CreateItem>`);

    const isSuccess = xml.includes('NoError') || xml.includes('ResponseClass="Success"');
    let errorMessage = null;

    if (!isSuccess) {
      const errorMatch = xml.match(/MessageText>([^<]+)/);
      errorMessage = errorMatch ? errorMatch[1] : 'Unknown EWS error';
    }

    return { success: isSuccess, error: errorMessage };
  }

  async getFolderMessageCount(folderId) {
    const xml = await this._ewsRequest(`
      <m:GetFolder>
        <m:FolderShape>
          <t:BaseShape>IdOnly</t:BaseShape>
          <t:AdditionalProperties>
            <t:FieldURI FieldURI="folder:TotalCount"/>
          </t:AdditionalProperties>
        </m:FolderShape>
        <m:FolderIds><t:FolderId Id="${folderId}"/></m:FolderIds>
      </m:GetFolder>`);

    const match = xml.match(/TotalCount>(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}
