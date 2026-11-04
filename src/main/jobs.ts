import { randomUUID } from 'node:crypto'
import type { Job, Platform } from '../shared/contracts'
import { AppDatabase, sqliteNow, toIso } from './database'
import { BrowserDownloader, BrowserProfileRecoveryError, DownloadCancelled } from './downloader'
import { LibraryService, MediaPathConflictError } from './library'
import { XHS_LOGIN_REQUIRED } from './platforms/xiaohongshu'

type Row = Record<string, any>

function jobFromRow(row: Row): Job {
  return {
    id: String(row.id), source_url: String(row.source_url), platform: row.platform ?? 'douyin', aweme_id: row.aweme_id ?? null,
    title: row.title ?? null, status: String(row.status), progress: Number(row.progress),
    downloaded_bytes: Number(row.downloaded_bytes), total_bytes: Number(row.total_bytes),
    current_item: Number(row.current_item), total_items: Number(row.total_items), error: row.error ?? null,
    collection_id: row.collection_id ?? null, created_at: toIso(row.created_at)!, updated_at: toIso(row.updated_at)!,
    completed_at: toIso(row.completed_at),
  }
}

export class JobManager {
  private readonly queue: string[] = []
  private processing = false
  private stopped = false
  private current: { id: string; controller: AbortController } | null = null

  constructor(
    private readonly database: AppDatabase,
    private readonly downloader: BrowserDownloader,
    private readonly library: LibraryService,
    private readonly notify: () => void,
  ) {}

  start(): void {
    const db = this.database.connection
    db.prepare(`UPDATE download_jobs SET status = 'interrupted', error = ?, updated_at = ?
      WHERE status IN ('resolving', 'downloading')`).run('应用上次运行时任务未完成', sqliteNow())
    const queued = db.prepare("SELECT id FROM download_jobs WHERE status = 'queued' ORDER BY created_at").all() as Row[]
    this.queue.push(...queued.map((row) => String(row.id)))
    void this.processNext()
  }

  async recoverIndexedFailures(): Promise<number> {
    const rows = this.database.connection.prepare(`SELECT * FROM download_jobs
      WHERE status = 'failed' AND collection_id IS NULL
        AND error = 'UNIQUE constraint failed: media_assets.path'
        AND aweme_id IS NOT NULL AND completed_at IS NOT NULL`).all() as Row[]
    let recovered = 0
    for (const row of rows) {
      const collection = await this.library.recoverIndexedDownload({
        jobId: String(row.id), awemeId: String(row.aweme_id), sourceUrl: String(row.source_url),
        outputDir: String(row.output_dir), downloadedBytes: Number(row.downloaded_bytes),
        createdAt: String(row.created_at), completedAt: String(row.completed_at),
      })
      if (collection) recovered += 1
    }
    if (recovered) this.notify()
    return recovered
  }

  hasActive(): boolean {
    const row = this.database.connection.prepare(`SELECT COUNT(*) AS count FROM download_jobs
      WHERE status IN ('queued', 'resolving', 'downloading')`).get() as Row
    return Number(row.count) > 0
  }

  list(limit = 100): Job[] {
    const rows = this.database.connection.prepare('SELECT * FROM download_jobs ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, limit))) as Row[]
    return rows.map(jobFromRow)
  }

  get(id: string): Job | null {
    const row = this.database.connection.prepare('SELECT * FROM download_jobs WHERE id = ?').get(id) as Row | undefined
    return row ? jobFromRow(row) : null
  }

  create(sourceUrl: string, platform: Platform, awemeId: string | null, outputDir: string, force: boolean): Job {
    const id = randomUUID().replaceAll('-', '')
    const now = sqliteNow()
    this.database.connection.prepare(`INSERT INTO download_jobs
      (id, source_url, platform, aweme_id, title, status, progress, downloaded_bytes, total_bytes,
       current_item, total_items, error, output_dir, force, collection_id, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, NULL, 'queued', 0, 0, 0, 0, 0, NULL, ?, ?, NULL, ?, ?, NULL)`)
      .run(id, sourceUrl, platform, awemeId, outputDir, force ? 1 : 0, now, now)
    this.queue.push(id)
    this.notify()
    void this.processNext()
    return this.get(id)!
  }

  cancel(id: string): Job {
    const job = this.get(id)
    if (!job) throw new Error('任务不存在')
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job
    if (this.current?.id === id) this.current.controller.abort()
    if (job.status === 'queued') {
      this.database.connection.prepare(`UPDATE download_jobs SET status = 'cancelled', error = NULL,
        completed_at = ?, updated_at = ? WHERE id = ?`).run(sqliteNow(), sqliteNow(), id)
    }
    this.notify()
    return this.get(id)!
  }

  retry(id: string): Job {
    const job = this.get(id)
    if (!job) throw new Error('任务不存在')
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) throw new Error('当前任务状态不可重试')
    this.database.connection.prepare(`UPDATE download_jobs SET status = 'queued', progress = 0,
      downloaded_bytes = 0, total_bytes = 0, current_item = 0, total_items = 0,
      error = NULL, completed_at = NULL, updated_at = ? WHERE id = ?`).run(sqliteNow(), id)
    this.queue.push(id)
    this.notify()
    void this.processNext()
    return this.get(id)!
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.current?.controller.abort()
    const deadline = Date.now() + 4_000
    while (this.processing && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.stopped) return
    this.processing = true
    try {
      while (this.queue.length && !this.stopped) {
        const id = this.queue.shift()!
        const job = this.get(id)
        if (!job || job.status !== 'queued') continue
        await this.run(id)
      }
    } finally {
      this.processing = false
    }
  }

  private async run(id: string): Promise<void> {
    const initial = this.get(id)
    if (!initial) return
    const db = this.database.connection
    const controller = new AbortController()
    this.current = { id, controller }
    db.prepare("UPDATE download_jobs SET status = 'resolving', updated_at = ? WHERE id = ?").run(sqliteNow(), id)
    this.notify()
    try {
      const result = await this.downloader.download(initial.source_url, String((db.prepare('SELECT output_dir FROM download_jobs WHERE id = ?').get(id) as Row).output_dir),
        controller.signal, (current, total, downloaded, itemTotal) => {
          const fraction = itemTotal ? downloaded / itemTotal : 0
          const progress = Math.min(0.999, ((current - 1) + fraction) / Math.max(total, 1))
          db.prepare(`UPDATE download_jobs SET status = 'downloading', progress = ?, downloaded_bytes = ?,
            total_bytes = ?, current_item = ?, total_items = ?, updated_at = ? WHERE id = ?`)
            .run(progress, downloaded, itemTotal, current, total, sqliteNow(), id)
          this.notify()
        })
      if (controller.signal.aborted) throw new DownloadCancelled('下载已取消')
      const collection = await this.library.addDownload({
        title: result.title || result.awemeId || '未命名作品', author: result.author, sourceUrl: result.sourceUrl,
        platform: result.platform, awemeId: result.awemeId, sourceCreatedAt: result.sourceCreatedAt, paths: result.paths,
      })
      db.prepare(`UPDATE download_jobs SET title = ?, platform = ?, aweme_id = ?, status = 'completed', progress = 1,
        current_item = ?, total_items = ?, collection_id = ?, error = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
        .run(result.title, result.platform, result.awemeId, result.paths.length, result.paths.length, collection.id, sqliteNow(), sqliteNow(), id)
    } catch (error) {
      const cancelled = error instanceof DownloadCancelled || controller.signal.aborted
      const message = cancelled ? null : friendlyError(error)
      db.prepare('UPDATE download_jobs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?')
        .run(cancelled ? 'cancelled' : 'failed', message, sqliteNow(), sqliteNow(), id)
    } finally {
      this.current = null
      this.notify()
    }
  }
}

export function friendlyError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const lower = text.toLowerCase()
  if (text.includes('登录浏览器仍在运行') || text.includes('登录浏览器已打开') || text === XHS_LOGIN_REQUIRED) return text.slice(0, 300)
  if (error instanceof MediaPathConflictError || lower.includes('unique constraint failed: media_assets.path')) {
    return error instanceof MediaPathConflictError ? text : '媒体文件已存在于媒体库，未自动合并'
  }
  if (error instanceof BrowserProfileRecoveryError || lower.includes('profile') || lower.includes('processsingleton')
    || lower.includes('user data dir') || lower.includes('already running')) {
    return '后台浏览器占用登录环境且无法自动接管，请重启应用后重试'
  }
  if (lower.includes('cookie') || text.includes('登录')) return '登录状态不可用，请重新打开登录浏览器'
  if (lower.includes('timeout') || text.includes('超时')) return '请求超时，请稍后重试'
  return text.slice(0, 300) || '下载失败'
}
