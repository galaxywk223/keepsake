import { app, BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { mkdir } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import type { CreateJobResult, LibraryQuery, ParsedSource, Settings } from '../shared/contracts'
import { AppDatabase, sqliteNow } from './database'
import { BrowserDownloader } from './downloader'
import { AudioExtractor } from './audio'
import { JobManager } from './jobs'
import { LibraryService } from './library'
import { extractUrls, identifySource, normalizeSourceUrl, UNSUPPORTED_SOURCE } from './parser'
import type { AppPaths } from './paths'

type Row = Record<string, any>

export class AppServices {
  readonly database: AppDatabase
  readonly downloader: BrowserDownloader
  readonly audio: AudioExtractor
  readonly library: LibraryService
  readonly jobs: JobManager
  private watcher: FSWatcher | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private window: BrowserWindow | null = null

  constructor(readonly paths: AppPaths) {
    this.database = new AppDatabase(paths.database)
    this.downloader = new BrowserDownloader(paths)
    this.audio = new AudioExtractor()
    this.library = new LibraryService(this.database, paths, () => this.notify())
    this.jobs = new JobManager(this.database, this.downloader, this.library, () => this.notify())
  }

  async initialize(): Promise<void> {
    const row = this.database.connection.prepare('SELECT * FROM app_settings WHERE id = 1').get() as Row | undefined
    if (!row) {
      const now = sqliteNow()
      this.database.connection.prepare('INSERT INTO app_settings(id, download_dir, created_at, updated_at) VALUES(1, ?, ?, ?)')
        .run(this.paths.defaultDownloadDir, now, now)
    }
    const settings = this.settingsRow()
    await mkdir(String(settings.download_dir), { recursive: true })
    await this.jobs.recoverIndexedFailures()
    await this.library.scan(String(settings.download_dir))
    this.startWatcher(String(settings.download_dir))
    this.jobs.start()
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window
  }

  notify(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('events:snapshot')
  }

  async parse(text: string): Promise<{ sources: ParsedSource[] }> {
    const sources: ParsedSource[] = []
    for (const rawUrl of extractUrls(text)) {
      const url = await normalizeSourceUrl(rawUrl)
      const source = identifySource(url)
      if (!source) continue
      const awemeId = source.id
      const existing = this.library.duplicate(source.platform, awemeId)
      sources.push({
        url, platform: source.platform, aweme_id: awemeId, duplicate: Boolean(existing), existing_collection_id: existing?.id ?? null,
      })
    }
    return { sources }
  }

  async createJobs(urls: string[], force: boolean): Promise<CreateJobResult[]> {
    const outputDir = String(this.settingsRow().download_dir)
    const results: CreateJobResult[] = []
    for (const rawUrl of urls) {
      const sourceUrl = await normalizeSourceUrl(rawUrl)
      const source = identifySource(sourceUrl)
      if (!source) throw new Error(UNSUPPORTED_SOURCE)
      const awemeId = source.id
      const existing = this.library.duplicate(source.platform, awemeId)
      if (existing && !force) {
        results.push({ source_url: sourceUrl, duplicate: true, existing_collection_id: existing.id, job: null })
      } else {
        results.push({
          source_url: sourceUrl, duplicate: false, existing_collection_id: null,
          job: this.jobs.create(sourceUrl, source.platform, awemeId, outputDir, force),
        })
      }
    }
    return results
  }

  queryLibrary(query: LibraryQuery) { return this.library.query(query) }
  getCollection(id: string) { return this.library.getCollection(id) }
  extractAudio(collectionId: string, assetId: string) {
    return this.library.addExtractedAudio(collectionId, assetId, String(this.settingsRow().download_dir), (sourcePath, outputPath) => this.audio.extract(sourcePath, outputPath))
  }
  renameCollection(id: string, title: string) { return this.library.renameCollection(id, title, String(this.settingsRow().download_dir)) }
  libraryAction(action: 'open' | 'reveal' | 'trash', ids: string[]) {
    return this.library.act(action, ids, String(this.settingsRow().download_dir))
  }

  async settings(): Promise<Settings> {
    const row = this.settingsRow()
    return {
      download_dir: String(row.download_dir),
      browser_profile_ready: await this.downloader.profileReady(),
      browser_ready: Boolean(this.downloader.browserExecutable()),
      app_version: app.getVersion(),
    }
  }

  async updateSettings(downloadDir: string): Promise<Settings> {
    const path = downloadDir.trim()
    if (!path) throw new Error('下载目录不能为空')
    await mkdir(path, { recursive: true })
    this.database.connection.prepare('UPDATE app_settings SET download_dir = ?, updated_at = ? WHERE id = 1')
      .run(path, sqliteNow())
    this.startWatcher(path)
    await this.library.scan(path)
    this.notify()
    return this.settings()
  }

  async selectDirectory(): Promise<Settings> {
    const current = String(this.settingsRow().download_dir)
    const options: OpenDialogOptions = {
      title: '选择下载目录', defaultPath: current, properties: ['openDirectory', 'createDirectory'],
    }
    const result = this.window
      ? await dialog.showOpenDialog(this.window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0] ? this.settings() : this.updateSettings(result.filePaths[0])
  }

  async openLogin(): Promise<{ opened: boolean }> {
    await this.downloader.openLogin(() => this.notify())
    this.notify()
    return { opened: true }
  }

  async openDataDirectory(): Promise<{ opened: boolean }> {
    const error = await shell.openPath(this.paths.dataDir)
    if (error) throw new Error(error)
    return { opened: true }
  }

  async rescan(): Promise<{ started: boolean }> {
    await this.library.scan(String(this.settingsRow().download_dir))
    return { started: true }
  }

  async stop(): Promise<void> {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.watcher?.close()
    await this.jobs.stop()
    await this.downloader.close()
    this.database.close()
  }

  private settingsRow(): Row {
    const row = this.database.connection.prepare('SELECT * FROM app_settings WHERE id = 1').get() as Row | undefined
    if (!row) throw new Error('应用设置不存在')
    return row
  }

  private startWatcher(path: string): void {
    this.watcher?.close()
    try {
      this.watcher = watch(path, { recursive: true }, () => {
        if (this.scanTimer) clearTimeout(this.scanTimer)
        this.scanTimer = setTimeout(() => void this.library.scan(path), 700)
      })
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null })
    } catch {
      this.watcher = null
    }
  }
}
