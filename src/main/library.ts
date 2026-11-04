import { nativeImage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Asset, Collection, LibraryQuery, LibraryResult, Platform } from '../shared/contracts'
import type { AppPaths } from './paths'
import { AppDatabase, sqliteNow, toIso } from './database'

const IMAGES = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])
const VIDEOS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v'])
const AUDIOS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'])
const ALL_MEDIA = new Set([...IMAGES, ...VIDEOS, ...AUDIOS])
const SEQUENCE = /^(.*)_(\d{2,3})$/
const INVALID_FILENAME = /[<>:"/\\|?*\r\n]+/g

type Row = Record<string, any>

interface PreparedAsset {
  id: string
  path: string
  filename: string
  kind: 'image' | 'video' | 'audio'
  mimeType: string
  extension: string
  size: number
  width: number | null
  height: number | null
  sequence: number
  modifiedAt: string
}

export interface IndexedDownloadRecovery {
  jobId: string
  awemeId: string
  sourceUrl: string
  outputDir: string
  downloadedBytes: number
  createdAt: string
  completedAt: string
}

export class MediaPathConflictError extends Error {}

function id(): string {
  return randomUUID().replaceAll('-', '')
}

function mimeFor(path: string, kind: 'image' | 'video' | 'audio'): string {
  const ext = extname(path).toLowerCase()
  const known: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.mp4': 'video/mp4',
    '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  }
  return known[ext] ?? `${kind}/*`
}

function assetFromRow(row: Row): Asset {
  return {
    id: String(row.id), filename: String(row.filename), kind: row.kind,
    mime_type: String(row.mime_type), extension: String(row.extension), size: Number(row.size),
    width: row.width == null ? null : Number(row.width), height: row.height == null ? null : Number(row.height),
    duration: row.duration == null ? null : Number(row.duration), sequence: Number(row.sequence),
  }
}

export class LibraryService {
  private scanning = false
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly database: AppDatabase,
    private readonly paths: AppPaths,
    private readonly notify: () => void,
  ) {}

  async scan(root: string): Promise<number> {
    if (this.scanning) return 0
    this.scanning = true
    try {
      return await this.serialize(async () => {
        await mkdir(root, { recursive: true })
        const files = await this.mediaFiles(root)
        const db = this.database.connection
        const existing = db.prepare('SELECT * FROM media_assets').all() as Row[]
        const existingByPath = new Map(existing.map((row) => [resolve(String(row.path)).toLowerCase(), row]))
        const current = new Set(files.map((path) => resolve(path).toLowerCase()))

        db.exec('BEGIN')
        try {
          for (const row of existing) {
            const path = resolve(String(row.path))
            if (this.inside(path, root) && !current.has(path.toLowerCase())) {
              db.prepare('DELETE FROM media_assets WHERE id = ?').run(row.id)
            }
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }

        const groups = new Map<string, Array<{ path: string; sequence: number }>>()
        for (const path of files) {
          const key = resolve(path).toLowerCase()
          if (existingByPath.has(key)) {
            const info = await stat(path)
            db.prepare('UPDATE media_assets SET filename = ?, size = ?, modified_at = ? WHERE id = ?')
              .run(basename(path), info.size, sqliteNow(info.mtime), existingByPath.get(key)!.id)
            continue
          }
          const extension = extname(path)
          const stem = basename(path, extension)
          const match = stem.match(SEQUENCE)
          const base = match?.[1] ?? stem
          const sequence = Number(match?.[2] ?? 1)
          const groupKey = `${dirname(path).toLowerCase()}\u0000${base}`
          const items = groups.get(groupKey) ?? []
          items.push({ path, sequence })
          groups.set(groupKey, items)
        }

        let added = 0
        for (const items of groups.values()) {
          items.sort((a, b) => a.sequence - b.sequence)
          const collectionId = id()
          const now = sqliteNow()
          const title = basename(items[0].path, extname(items[0].path)).replace(SEQUENCE, '$1')
          const mediaType = this.collectionType(items.map((item) => item.path))
          db.prepare(`INSERT INTO media_collections
            (id, aweme_id, source_url, title, author, media_type, item_count, imported, source_created_at, created_at, updated_at)
            VALUES (?, NULL, NULL, ?, NULL, ?, ?, 1, NULL, ?, ?)`)
            .run(collectionId, title, mediaType, items.length, now, now)
          for (const item of items) {
            await this.insertAsset(collectionId, item.path, item.sequence)
            added += 1
          }
        }
        this.cleanupCollections()
        if (added || files.length !== existing.length) this.notify()
        return added
      })
    } finally {
      this.scanning = false
    }
  }

  async addDownload(input: {
    title: string; author: string | null; sourceUrl: string; platform?: Platform; awemeId: string | null;
    sourceCreatedAt: string | null; paths: string[]
  }): Promise<Collection> {
    return this.serialize(async () => {
      const db = this.database.connection
      const paths = input.paths.map((path) => resolve(path))
      const pathKeys = paths.map((path) => path.toLowerCase())
      if (new Set(pathKeys).size !== paths.length) throw new MediaPathConflictError('下载结果包含重复文件路径')
      const placeholders = paths.map(() => '?').join(', ')
      const existing = paths.length ? db.prepare(`SELECT a.*, c.imported, c.platform, c.aweme_id, c.source_url
        FROM media_assets a JOIN media_collections c ON c.id = a.collection_id
        WHERE LOWER(a.path) IN (${placeholders})`).all(...pathKeys) as Row[] : []
      const official = existing.filter((row) => !row.imported)
      if (official.length) {
        const collectionIds = new Set(official.map((row) => String(row.collection_id)))
        const collectionId = collectionIds.size === 1 ? [...collectionIds][0] : null
        const sameDownload = collectionId && existing.length === paths.length
          && existing.every((row) => String(row.collection_id) === collectionId)
          && official.every((row) => input.awemeId
            ? row.platform === (input.platform ?? 'douyin') && row.aweme_id === input.awemeId : row.source_url === input.sourceUrl)
        if (sameDownload) return this.getCollection(collectionId)
        throw new MediaPathConflictError('媒体文件已存在于其他作品，未自动合并')
      }

      const existingByPath = new Map(existing.map((row) => [resolve(String(row.path)).toLowerCase(), row]))
      const missing = paths.flatMap((path, index) => existingByPath.has(pathKeys[index])
        ? [] : [{ path, sequence: index + 1 }])
      const prepared = await Promise.all(missing.map((item) => this.prepareAsset(item.path, item.sequence)))
      const collectionId = id()
      const now = sqliteNow()
      let preparedIndex = 0
      db.exec('BEGIN')
      try {
        db.prepare(`INSERT INTO media_collections
          (id, platform, aweme_id, source_url, title, author, media_type, item_count, imported, source_created_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
          .run(collectionId, input.platform ?? 'douyin', input.awemeId, input.sourceUrl, input.title.trim() || '未命名作品', input.author,
            this.collectionType(paths), paths.length, input.sourceCreatedAt, now, now)
        for (let index = 0; index < paths.length; index += 1) {
          const existingAsset = existingByPath.get(pathKeys[index])
          if (existingAsset) {
            db.prepare('UPDATE media_assets SET collection_id = ?, sequence = ? WHERE id = ?')
              .run(collectionId, index + 1, existingAsset.id)
          } else {
            this.insertPreparedAsset(collectionId, prepared[preparedIndex++])
          }
        }
        this.cleanupCollections()
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      for (const asset of prepared) void this.thumbnailPath(asset.id, dirname(asset.path)).catch(() => undefined)
      this.notify()
      return this.getCollection(collectionId)
    })
  }

  async addExtractedAudio(
    collectionId: string,
    sourceAssetId: string,
    root: string,
    convert: (sourcePath: string, outputPath: string) => Promise<void>,
  ): Promise<Collection> {
    return this.serialize(async () => {
      const collection = this.getCollection(collectionId)
      const source = collection.assets?.find((asset) => asset.id === sourceAssetId)
      if (!source) throw new Error('源媒体文件不存在')
      if (source.kind !== 'video') throw new Error('只能从视频提取音频')
      const sourcePath = this.assetPath(sourceAssetId, root)
      const outputPath = join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}.mp3`)
      this.requireInside(outputPath, root)
      const existing = this.database.connection.prepare('SELECT * FROM media_assets WHERE LOWER(path) = LOWER(?)').get(resolve(outputPath)) as Row | undefined
      if (existing) {
        if (String(existing.collection_id) !== collectionId || existing.kind !== 'audio') throw new MediaPathConflictError('音频文件已存在于其他作品')
        return this.getCollection(collectionId)
      }
      try {
        await stat(outputPath)
        throw new MediaPathConflictError('音频输出文件已存在，未覆盖')
      } catch (error) {
        if (error instanceof MediaPathConflictError) throw error
      }
      const sequence = Math.max(0, ...(collection.assets ?? []).map((asset) => asset.sequence)) + 1
      await convert(sourcePath, outputPath)
      try {
        await this.insertAsset(collectionId, outputPath, sequence)
      } catch (error) {
        await unlink(outputPath).catch(() => undefined)
        throw error
      }
      this.cleanupCollections()
      this.notify()
      return this.getCollection(collectionId)
    })
  }

  async recoverIndexedDownload(input: IndexedDownloadRecovery): Promise<Collection | null> {
    return this.serialize(async () => {
      const db = this.database.connection
      const emptyCollections = db.prepare(`SELECT c.* FROM media_collections c
        LEFT JOIN media_assets a ON a.collection_id = c.id
        WHERE c.aweme_id = ? AND c.source_url = ? AND c.created_at BETWEEN ? AND ?
        GROUP BY c.id HAVING COUNT(a.id) = 0`)
        .all(input.awemeId, input.sourceUrl, input.createdAt, input.completedAt) as Row[]
      if (emptyCollections.length !== 1) return null
      const empty = emptyCollections[0]
      const candidates = db.prepare(`SELECT c.*, COUNT(a.id) AS asset_count, SUM(a.size) AS total_size
        FROM media_collections c JOIN media_assets a ON a.collection_id = c.id
        WHERE c.imported = 1 AND c.title = ? AND c.media_type = ? AND c.created_at BETWEEN ? AND ?
        GROUP BY c.id HAVING COUNT(a.id) = ? AND SUM(a.size) = ?`)
        .all(empty.title, empty.media_type, input.createdAt, input.completedAt,
          empty.item_count, input.downloadedBytes) as Row[]
      const valid: Row[] = []
      for (const candidate of candidates) {
        const assets = db.prepare('SELECT * FROM media_assets WHERE collection_id = ?').all(candidate.id) as Row[]
        if (!assets.every((asset) => this.inside(String(asset.path), input.outputDir))) continue
        const current = await Promise.all(assets.map(async (asset) => {
          try { return (await stat(String(asset.path))).size === Number(asset.size) } catch { return false }
        }))
        if (current.every(Boolean)) valid.push(candidate)
      }
      if (valid.length !== 1) return null

      const candidate = valid[0]
      const now = sqliteNow()
      db.exec('BEGIN')
      try {
        db.prepare(`UPDATE media_collections SET platform = ?, aweme_id = ?, source_url = ?, title = ?, author = ?,
          imported = 0, source_created_at = ?, updated_at = ? WHERE id = ?`)
          .run(empty.platform, empty.aweme_id, empty.source_url, empty.title, empty.author,
            empty.source_created_at, now, candidate.id)
        db.prepare('DELETE FROM media_collections WHERE id = ?').run(empty.id)
        const update = db.prepare(`UPDATE download_jobs SET title = ?, status = 'completed', progress = 1,
          current_item = ?, total_items = ?, collection_id = ?, error = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'failed' AND collection_id IS NULL`)
          .run(empty.title, candidate.asset_count, candidate.asset_count, candidate.id, now, now, input.jobId)
        if (Number(update.changes) !== 1) throw new Error('待修复任务状态已变化')
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      this.notify()
      return this.getCollection(String(candidate.id))
    })
  }

  query(query: LibraryQuery): LibraryResult {
    const db = this.database.connection
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (query.search.trim()) {
      conditions.push('(LOWER(title) LIKE LOWER(?) OR LOWER(COALESCE(author, \'\')) LIKE LOWER(?))')
      const pattern = `%${query.search.trim()}%`
      params.push(pattern, pattern)
    }
    if (query.media_type === 'image' || query.media_type === 'video') {
      conditions.push('media_type = ?')
      params.push(query.media_type)
    } else if (query.media_type === 'audio') {
      conditions.push(`(media_type = 'audio' OR EXISTS (
        SELECT 1 FROM media_assets audio_assets
        WHERE audio_assets.collection_id = media_collections.id AND audio_assets.kind = 'audio'
      ))`)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const order = query.sort === 'oldest' ? 'created_at ASC' : query.sort === 'name' ? 'title COLLATE NOCASE ASC'
      : query.sort === 'size' ? 'item_count DESC' : 'created_at DESC'
    const page = Math.max(1, query.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, query.page_size ?? 60))
    const total = Number((db.prepare(`SELECT COUNT(*) AS count FROM media_collections ${where}`).get(...params) as Row).count)
    const rows = db.prepare(`SELECT * FROM media_collections ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as Row[]
    return { items: rows.map((row) => this.collectionFromRow(row, false)), total }
  }

  getCollection(collectionId: string): Collection {
    const row = this.database.connection.prepare('SELECT * FROM media_collections WHERE id = ?').get(collectionId) as Row | undefined
    if (!row) throw new Error('作品不存在')
    return this.collectionFromRow(row, true)
  }

  duplicate(platform: Platform, awemeId: string | null): Collection | null {
    if (!awemeId) return null
    const row = this.database.connection.prepare(`SELECT * FROM media_collections
      WHERE platform = ? AND aweme_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(platform, awemeId) as Row | undefined
    return row ? this.collectionFromRow(row, false) : null
  }

  async renameCollection(collectionId: string, title: string, root: string): Promise<Collection> {
    const collection = this.getCollection(collectionId)
    const safe = title.replace(INVALID_FILENAME, '_').trim().slice(0, 120).replace(/[ .]+$/, '')
    if (!safe) throw new Error('名称不能为空')
    const completed: Array<{ from: string; to: string }> = []
    try {
      for (const asset of collection.assets ?? []) {
        const row = this.assetRow(asset.id)
        const oldPath = resolve(String(row.path))
        this.requireInside(oldPath, root)
        const suffix = collection.item_count > 1 ? `_${String(asset.sequence).padStart(2, '0')}` : ''
        const newPath = join(dirname(oldPath), `${safe}${suffix}${extname(oldPath)}`)
        if (oldPath !== newPath) {
          await rename(oldPath, newPath)
          completed.push({ from: newPath, to: oldPath })
        }
        this.database.connection.prepare('UPDATE media_assets SET path = ?, filename = ? WHERE id = ?')
          .run(newPath, basename(newPath), asset.id)
      }
      this.database.connection.prepare('UPDATE media_collections SET title = ?, updated_at = ? WHERE id = ?')
        .run(safe, sqliteNow(), collectionId)
      this.notify()
      return this.getCollection(collectionId)
    } catch (error) {
      for (const change of completed.reverse()) await rename(change.from, change.to).catch(() => undefined)
      throw error
    }
  }

  async act(action: 'open' | 'reveal' | 'trash', ids: string[], root: string): Promise<number> {
    const collections = ids.map((collectionId) => this.getCollection(collectionId))
    if ((action === 'open' || action === 'reveal') && collections.length !== 1) {
      throw new Error('打开和定位操作仅支持单个作品')
    }
    const first = collections[0].assets?.[0]
    if ((action === 'open' || action === 'reveal') && !first) throw new Error('媒体文件不存在')
    if (action === 'open' && first) {
      const path = this.assetPath(first.id, root)
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
      return 1
    }
    if (action === 'reveal' && first) {
      shell.showItemInFolder(this.assetPath(first.id, root))
      return 1
    }
    for (const collection of collections) {
      for (const asset of collection.assets ?? []) {
        const row = this.assetRow(asset.id)
        const path = this.assetPath(asset.id, root)
        await shell.trashItem(path)
        if (row.thumbnail_path) await unlink(String(row.thumbnail_path)).catch(() => undefined)
      }
      this.database.connection.prepare('DELETE FROM media_collections WHERE id = ?').run(collection.id)
    }
    this.notify()
    return collections.length
  }

  assetPath(assetId: string, root: string): string {
    const path = resolve(String(this.assetRow(assetId).path))
    this.requireInside(path, root)
    return path
  }

  async thumbnailPath(assetId: string, root: string): Promise<string | null> {
    const row = this.assetRow(assetId)
    if (row.thumbnail_path) {
      try { await stat(String(row.thumbnail_path)); return String(row.thumbnail_path) } catch { /* regenerate */ }
    }
    const source = this.assetPath(assetId, root)
    const output = join(this.paths.thumbnailDir, `${assetId}.jpg`)
    try {
      const image = await nativeImage.createThumbnailFromPath(source, { width: 720, height: 720 })
      if (image.isEmpty()) return null
      await writeFile(output, image.toJPEG(84))
      this.database.connection.prepare('UPDATE media_assets SET thumbnail_path = ? WHERE id = ?').run(output, assetId)
      return output
    } catch {
      return null
    }
  }

  private async insertAsset(collectionId: string, path: string, sequence: number): Promise<void> {
    const asset = await this.prepareAsset(path, sequence)
    this.insertPreparedAsset(collectionId, asset)
    void this.thumbnailPath(asset.id, dirname(asset.path)).catch(() => undefined)
  }

  private async prepareAsset(path: string, sequence: number): Promise<PreparedAsset> {
    const info = await stat(path)
    const extension = extname(path).toLowerCase()
    const kind: 'image' | 'video' | 'audio' = IMAGES.has(extension) ? 'image' : AUDIOS.has(extension) ? 'audio' : 'video'
    const assetId = id()
    let width: number | null = null
    let height: number | null = null
    if (kind === 'image') {
      const size = nativeImage.createFromPath(path).getSize()
      if (size.width && size.height) { width = size.width; height = size.height }
    }
    return {
      id: assetId, path: resolve(path), filename: basename(path), kind, mimeType: mimeFor(path, kind),
      extension: extension.slice(1), size: info.size, width, height, sequence, modifiedAt: sqliteNow(info.mtime),
    }
  }

  private insertPreparedAsset(collectionId: string, asset: PreparedAsset): void {
    this.database.connection.prepare(`INSERT INTO media_assets
      (id, collection_id, path, filename, kind, mime_type, extension, size, width, height, duration, sequence, thumbnail_path, modified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`)
      .run(asset.id, collectionId, asset.path, asset.filename, asset.kind, asset.mimeType, asset.extension, asset.size,
        asset.width, asset.height, asset.sequence, asset.modifiedAt)
  }

  private collectionFromRow(row: Row, includeAssets: boolean): Collection {
    const assets = this.database.connection.prepare('SELECT * FROM media_assets WHERE collection_id = ? ORDER BY sequence')
      .all(row.id) as Row[]
    return {
      id: String(row.id), platform: row.platform ?? 'douyin', aweme_id: row.aweme_id ?? null, source_url: row.source_url ?? null,
      title: String(row.title), author: row.author ?? null, media_type: row.media_type,
      item_count: Number(row.item_count), imported: Boolean(row.imported), source_created_at: toIso(row.source_created_at),
      created_at: toIso(row.created_at)!, updated_at: toIso(row.updated_at)!,
      cover_asset_id: assets[0]?.id ? String(assets[0].id) : null,
      total_size: assets.reduce((sum, asset) => sum + Number(asset.size), 0),
      assets: includeAssets ? assets.map(assetFromRow) : null,
    }
  }

  private assetRow(assetId: string): Row {
    const row = this.database.connection.prepare('SELECT * FROM media_assets WHERE id = ?').get(assetId) as Row | undefined
    if (!row) throw new Error('文件不存在')
    return row
  }

  private cleanupCollections(): void {
    const db = this.database.connection
    db.exec(`DELETE FROM media_collections
      WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE media_assets.collection_id = media_collections.id)
        AND NOT EXISTS (
          SELECT 1 FROM download_jobs
          WHERE download_jobs.status = 'failed'
            AND download_jobs.collection_id IS NULL
            AND download_jobs.error = 'UNIQUE constraint failed: media_assets.path'
            AND download_jobs.aweme_id = media_collections.aweme_id
            AND download_jobs.source_url = media_collections.source_url
            AND media_collections.created_at BETWEEN download_jobs.created_at AND download_jobs.completed_at
        )`)
    const rows = db.prepare(`SELECT collection_id, COUNT(*) AS count,
      COUNT(DISTINCT kind) AS kinds, MIN(kind) AS kind FROM media_assets GROUP BY collection_id`).all() as Row[]
    for (const row of rows) {
      db.prepare('UPDATE media_collections SET item_count = ?, media_type = ? WHERE id = ?')
        .run(row.count, Number(row.kinds) === 1 ? row.kind : 'mixed', row.collection_id)
    }
  }

  private async mediaFiles(root: string): Promise<string[]> {
    const result: string[] = []
    const pending = [resolve(root)]
    while (pending.length) {
      const directory = pending.pop()!
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { if (entry.name !== '.app-data') pending.push(path) }
        else if (entry.isFile() && ALL_MEDIA.has(extname(entry.name).toLowerCase()) && !entry.name.endsWith('.part')) result.push(path)
      }
    }
    return result
  }

  private collectionType(paths: string[]): 'image' | 'video' | 'audio' | 'mixed' {
    const kinds = new Set(paths.map((path) => {
      const extension = extname(path).toLowerCase()
      return IMAGES.has(extension) ? 'image' : AUDIOS.has(extension) ? 'audio' : 'video'
    }))
    return kinds.size === 1 ? [...kinds][0] as 'image' | 'video' | 'audio' : 'mixed'
  }

  private inside(path: string, root: string): boolean {
    const value = relative(resolve(root), resolve(path))
    return value === '' || (!value.startsWith('..') && !isAbsolute(value))
  }

  private requireInside(path: string, root: string): void {
    if (!this.inside(path, root)) throw new Error('文件不在当前下载目录内')
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail
    let release!: () => void
    this.mutationTail = new Promise<void>((resolvePromise) => { release = resolvePromise })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
