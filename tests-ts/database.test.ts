// @vitest-environment node

import { afterEach, describe, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase, toIso } from '../src/main/database'

const directories: string[] = []
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('database', () => {
  test('creates the compatible schema and migration marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oml-db-'))
    directories.push(directory)
    const database = new AppDatabase(join(directory, 'library.db'))
    const tables = database.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => String((row as Record<string, unknown>).name))
    expect(tables).toEqual(expect.arrayContaining(['app_settings', 'download_jobs', 'media_collections', 'media_assets', 'schema_migrations']))
    expect(toIso('2026-08-01 02:22:57.952917')).toBe('2026-08-01T02:22:57.952917Z')
    database.close()
  })

  test('adds platform columns to a v1 database and keeps existing rows as douyin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oml-db-'))
    directories.push(directory)
    const path = join(directory, 'library.db')
    const first = new AppDatabase(path)
    first.connection.exec(`
      DROP INDEX ix_media_collections_platform_aweme_id;
      ALTER TABLE media_collections DROP COLUMN platform;
      ALTER TABLE download_jobs DROP COLUMN platform;
      DELETE FROM schema_migrations WHERE version = 2;
      INSERT INTO media_collections
        (id, aweme_id, source_url, title, author, media_type, item_count, imported, source_created_at, created_at, updated_at)
        VALUES ('c1', '123', 'https://www.douyin.com/video/123', 't', NULL, 'video', 1, 0, NULL, '2026-01-01', '2026-01-01');
    `)
    first.close()

    const second = new AppDatabase(path)
    const row = second.connection.prepare('SELECT platform FROM media_collections WHERE id = ?').get('c1') as Record<string, unknown>
    expect(row.platform).toBe('douyin')
    const versions = second.connection.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
      .map((item) => Number((item as Record<string, unknown>).version))
    expect(versions).toEqual([1, 2])
    second.close()
    expect(() => new AppDatabase(path).close()).not.toThrow()
  })
})
