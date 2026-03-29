const fs = require('fs').promises;

class AutomatedCopyrightFingerprintingService {
  constructor(database) {
    this.database = database;
  }

  async ensureSchema() {
    await this.run(
      `CREATE TABLE IF NOT EXISTS protected_video_hashes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at TEXT NOT NULL
      )`,
      [],
    );

    await this.run(
      `CREATE TABLE IF NOT EXISTS video_fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        phash TEXT NOT NULL,
        matched_protected_hash_id INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (matched_protected_hash_id) REFERENCES protected_video_hashes(id)
      )`,
      [],
    );
  }

  async generatePerceptualHash(filePath) {
    const buffer = await fs.readFile(filePath);
    return this.buildPerceptualHashFromBuffer(buffer);
  }

  buildPerceptualHashFromBuffer(buffer) {
    const sampleCount = 64;

    if (!buffer || buffer.length === 0) {
      return '0000000000000000';
    }

    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const index = Math.floor((i * (buffer.length - 1)) / (sampleCount - 1));
      samples.push(buffer[index]);
    }

    const average = samples.reduce((sum, value) => sum + value, 0) / sampleCount;
    const bits = samples.map((value) => (value >= average ? 1 : 0));

    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      const nibble = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
      hex += nibble.toString(16);
    }

    return hex;
  }

  async findProtectedMatch(phash) {
    return this.get(
      'SELECT id, phash, label, created_at AS createdAt FROM protected_video_hashes WHERE phash = ? LIMIT 1',
      [phash],
    );
  }

  async recordFingerprint({ videoId, phash, matchedProtectedHashId, status }) {
    await this.run(
      `INSERT INTO video_fingerprints
      (video_id, phash, matched_protected_hash_id, status, created_at)
      VALUES (?, ?, ?, ?, ?)`,
      [videoId, phash, matchedProtectedHashId || null, status, new Date().toISOString()],
    );
  }

  async run(sql, params = []) {
    if (typeof this.database.run === 'function') {
      return this.database.run(sql, params);
    }

    if (this.database && this.database.db && typeof this.database.db.prepare === 'function') {
      return this.database.db.prepare(sql).run(...params);
    }

    throw new Error('Unsupported database adapter: run() is not available');
  }

  async get(sql, params = []) {
    if (typeof this.database.get === 'function') {
      return this.database.get(sql, params);
    }

    if (this.database && this.database.db && typeof this.database.db.prepare === 'function') {
      return this.database.db.prepare(sql).get(...params);
    }

    throw new Error('Unsupported database adapter: get() is not available');
  }
}

module.exports = AutomatedCopyrightFingerprintingService;