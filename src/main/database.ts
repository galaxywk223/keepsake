import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

export function sqliteNow(date = new Date()): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

export function toIso(value: unknown): string | null {
  if (!value) return null
  const text = String(value)
  return text.includes('T') ? (text.endsWith('Z') ? text : `${text}Z`) : `${text.replace(' ', 'T')}Z`
}

export class AppDatabase {
  readonly connection: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.connection = new DatabaseSync(path)
    this.connection.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  close(): void {
    this.connection.close()
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY,
        download_dir TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_collections (
        id VARCHAR(32) PRIMARY KEY,
        aweme_id VARCHAR(64),
        source_url TEXT,
        title TEXT NOT NULL,
        author VARCHAR(255),
        media_type VARCHAR(16) NOT NULL,
        item_count INTEGER NOT NULL,
        imported BOOLEAN NOT NULL,
        source_created_at DATETIME,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      );
      CREATE TABLE IF NOT EXISTS download_jobs (
        id VARCHAR(32) PRIMARY KEY,
        source_url TEXT NOT NULL,
        aweme_id VARCHAR(64),
        title TEXT,
        status VARCHAR(24) NOT NULL,
        progress FLOAT NOT NULL,
        downloaded_bytes INTEGER NOT NULL,
        total_bytes INTEGER NOT NULL,
        current_item INTEGER NOT NULL,
        total_items INTEGER NOT NULL,
        error TEXT,
        output_dir TEXT NOT NULL,
        force BOOLEAN NOT NULL,
        collection_id VARCHAR(32),
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME,
        FOREIGN KEY(collection_id) REFERENCES media_collections(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS media_assets (
        id VARCHAR(32) PRIMARY KEY,
        collection_id VARCHAR(32) NOT NULL,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        kind VARCHAR(16) NOT NULL,
        mime_type VARCHAR(128) NOT NULL,
        extension VARCHAR(16) NOT NULL,
        size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        duration FLOAT,
        sequence INTEGER NOT NULL,
        thumbnail_path TEXT,
        modified_at DATETIME NOT NULL,
        FOREIGN KEY(collection_id) REFERENCES media_collections(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS ix_download_jobs_status ON download_jobs(status);
      CREATE INDEX IF NOT EXISTS ix_media_collections_aweme_id ON media_collections(aweme_id);
      CREATE INDEX IF NOT EXISTS ix_media_collections_updated_at ON media_collections(updated_at);
      CREATE INDEX IF NOT EXISTS ix_media_assets_collection_id ON media_assets(collection_id);
    `)
    const now = sqliteNow()
    this.connection.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)').run(now)
    this.migratePlatform(now)
  }

  /** v2: records which site a job or collection came from; existing rows are Douyin. */
  private migratePlatform(now: string): void {
    const applied = this.connection.prepare('SELECT 1 FROM schema_migrations WHERE version = 2').get()
    if (applied) return
    this.connection.exec('BEGIN')
    try {
      for (const table of ['media_collections', 'download_jobs']) {
        const columns = this.connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        if (!columns.some((column) => column.name === 'platform')) {
          this.connection.exec(`ALTER TABLE ${table} ADD COLUMN platform VARCHAR(32) NOT NULL DEFAULT 'douyin'`)
        }
      }
      this.connection.exec(`CREATE INDEX IF NOT EXISTS ix_media_collections_platform_aweme_id
        ON media_collections(platform, aweme_id)`)
      this.connection.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)').run(now)
      this.connection.exec('COMMIT')
    } catch (error) {
      this.connection.exec('ROLLBACK')
      throw error
    }
  }
}
