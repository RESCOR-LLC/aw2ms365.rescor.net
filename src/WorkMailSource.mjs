/**
 * WorkMail IMAP source — connects to WorkMail via IMAP, enumerates folders,
 * and streams messages as raw RFC 822 MIME.
 */
import Imap from 'imap';

export class WorkMailSource {

  constructor(config) {
    this.host = config.source.host;
    this.port = config.source.port || 993;
    this.tls = config.source.tls !== false;
    this.user = config.source.user;
    this.password = config.source.password;
    this.connection = null;
  }

  async connect() {
    const connection = new Imap({
      user: this.user,
      password: this.password,
      host: this.host,
      port: this.port,
      tls: this.tls,
      tlsOptions: { servername: this.host },
      connTimeout: 30000,
      authTimeout: 15000,
    });

    await new Promise((resolve, reject) => {
      connection.once('ready', resolve);
      connection.once('error', reject);
      connection.connect();
    });

    this.connection = connection;
    return this;
  }

  async listFolders() {
    const connection = this.connection;
    const boxes = await new Promise((resolve, reject) => {
      connection.getBoxes((error, result) => {
        if (error) { reject(error); } else { resolve(result); }
      });
    });

    const folders = [];
    this._flattenBoxes(boxes, '', folders);
    return folders;
  }

  _flattenBoxes(boxes, prefix, result) {
    for (const [name, box] of Object.entries(boxes)) {
      const fullPath = prefix ? `${prefix}${box.delimiter}${name}` : name;
      result.push({ name: fullPath, delimiter: box.delimiter, attributes: box.attribs || [] });
      if (box.children) {
        this._flattenBoxes(box.children, fullPath, result);
      }
    }
  }

  async openFolder(folderName) {
    const connection = this.connection;
    const box = await new Promise((resolve, reject) => {
      connection.openBox(folderName, true, (error, result) => {
        if (error) { reject(error); } else { resolve(result); }
      });
    });
    return { name: folderName, totalMessages: box.messages.total, uidValidity: box.uidvalidity };
  }

  async getMessageUids(folderName) {
    await this.openFolder(folderName);
    const connection = this.connection;

    if (connection._box.messages.total === 0) {
      return [];
    }

    const uids = await new Promise((resolve, reject) => {
      connection.uid.search(['ALL'], (error, result) => {
        if (error) { reject(error); } else { resolve(result); }
      });
    });

    return uids.sort((a, b) => a - b);
  }

  async fetchMessageMime(uid) {
    const connection = this.connection;

    const mimeBuffer = await new Promise((resolve, reject) => {
      const fetch = connection.uid.fetch([uid], { bodies: '', struct: false });
      let buffer = Buffer.alloc(0);

      fetch.on('message', (message) => {
        message.on('body', (stream) => {
          const chunks = [];
          stream.on('data', (chunk) => { chunks.push(chunk); });
          stream.on('end', () => { buffer = Buffer.concat(chunks); });
        });
      });

      fetch.on('end', () => { resolve(buffer); });
      fetch.on('error', reject);
    });

    return mimeBuffer;
  }

  disconnect() {
    if (this.connection) {
      this.connection.end();
      this.connection = null;
    }
  }
}
