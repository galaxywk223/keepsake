import puppeteer, { type Browser } from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { Platform } from '../shared/contracts'
import type { AppPaths } from './paths'
import { normalizeSourceUrl } from './parser'
import { DownloadCancelled, extractorFor, extractors, type Candidate } from './platforms'

export { DownloadCancelled }

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
const DEVTOOLS_PATH = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/
const RECOVERY_TIMEOUT_MS = 3_000
const RECOVERY_POLL_MS = 100

export interface DownloadResult {
  sourceUrl: string
  platform: Platform
  paths: string[]
  title: string | null
  author: string | null
  awemeId: string | null
  sourceCreatedAt: string | null
}

export class BrowserProfileRecoveryError extends Error {}

export interface BrowserApi {
  launch(options: Parameters<typeof puppeteer.launch>[0]): Promise<Browser>
  connect(options: Parameters<typeof puppeteer.connect>[0]): Promise<Browser>
}

export interface BrowserDownloaderDependencies {
  browserApi?: BrowserApi
  recoveryTimeoutMs?: number
  recoveryPollMs?: number
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

export class BrowserDownloader {
  private loginBrowser: Browser | null = null
  private readonly browserApi: BrowserApi
  private readonly recoveryTimeoutMs: number
  private readonly recoveryPollMs: number

  constructor(private readonly paths: AppPaths, dependencies: BrowserDownloaderDependencies = {}) {
    this.browserApi = dependencies.browserApi ?? puppeteer
    this.recoveryTimeoutMs = dependencies.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS
    this.recoveryPollMs = dependencies.recoveryPollMs ?? RECOVERY_POLL_MS
  }

  browserExecutable(): string | null {
    const env = process.env
    const candidates = [
      join(env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
  }

  async profileReady(): Promise<boolean> {
    return exists(join(this.paths.browserProfileDir, 'Default'))
  }

  loginOpen(): boolean {
    return Boolean(this.loginBrowser?.connected)
  }

  async openLogin(onClosed: () => void): Promise<void> {
    if (this.loginOpen()) throw new Error('登录浏览器已打开')
    const executablePath = this.browserExecutable()
    if (!executablePath) throw new Error('未找到 Microsoft Edge 或 Google Chrome')
    await mkdir(this.paths.browserProfileDir, { recursive: true })
    this.loginBrowser = await this.launchManaged({
      executablePath,
      userDataDir: this.paths.browserProfileDir,
      headless: false,
      defaultViewport: null,
      args: ['--new-window'],
    })
    this.loginBrowser.on('disconnected', () => {
      this.loginBrowser = null
      onClosed()
    })
    const pages = await this.loginBrowser.pages()
    for (const [index, extractor] of extractors.entries()) {
      const page = (index === 0 ? pages[0] : undefined) ?? await this.loginBrowser.newPage()
      await page.setUserAgent(USER_AGENT)
      await page.goto(extractor.homeUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    }
  }

  async close(): Promise<void> {
    await this.loginBrowser?.close().catch(() => undefined)
    this.loginBrowser = null
    await this.cleanupProfileBrowser()
  }

  async download(
    source: string,
    outputDir: string,
    signal: AbortSignal,
    progress: (current: number, total: number, downloaded: number, itemTotal: number) => void,
  ): Promise<DownloadResult> {
    if (this.loginOpen()) throw new Error('登录浏览器仍在运行，请关闭后重试')
    if (!(await this.profileReady())) throw new Error('需要先打开登录浏览器并完成登录')
    const executablePath = this.browserExecutable()
    if (!executablePath) throw new Error('未找到 Microsoft Edge 或 Google Chrome')
    const url = await normalizeSourceUrl(source)
    const extractor = extractorFor(url)
    if (!extractor) throw new Error('仅支持抖音、小红书作品链接')
    let browser: Browser | null = null
    try {
      browser = await this.launchManaged({
        executablePath,
        userDataDir: this.paths.browserProfileDir,
        headless: true,
        defaultViewport: { width: 1280, height: 900 },
      })
      const page = (await browser.pages())[0] ?? await browser.newPage()
      await page.setUserAgent(USER_AGENT)
      const detail = await extractor.capture(page, url, signal)
      const candidates = detail.candidates
      if (!candidates.length) throw new Error('页面详情中没有找到原始媒体')
      const title = safeName(detail.title || detail.id || extractor.platform, extractor.platform)
      await mkdir(outputDir, { recursive: true })
      const paths: string[] = []
      const multiple = new Set(candidates.map((candidate) => candidate.sequence)).size > 1
      for (const [index, candidate] of candidates.entries()) {
        if (signal.aborted) throw new DownloadCancelled('下载已取消')
        paths.push(await this.downloadCandidate(candidate, index + 1, candidates.length, multiple, outputDir, title,
          extractor.referer, signal, progress))
      }
      return {
        sourceUrl: url, platform: extractor.platform, paths, title: detail.title, author: detail.author,
        awemeId: detail.id || extractor.extractId(url), sourceCreatedAt: detail.createdAt,
      }
    } finally {
      await browser?.close().catch(() => undefined)
      await this.cleanupProfileBrowser()
    }
  }

  private async launchManaged(options: Parameters<typeof puppeteer.launch>[0]): Promise<Browser> {
    await this.cleanupProfileBrowser()
    try {
      return await this.browserApi.launch(options)
    } catch (launchError) {
      const recovered = await this.pollForProfileBrowser()
      if (recovered.browser) return recovered.browser
      if (recovered.endpointSeen || isProfileLockError(launchError)) {
        throw new BrowserProfileRecoveryError('后台浏览器占用登录环境且无法自动接管，请重启应用后重试', {
          cause: launchError,
        })
      }
      throw launchError
    }
  }

  private async cleanupProfileBrowser(): Promise<void> {
    if (this.loginOpen()) return
    const endpoint = await this.readProfileEndpoint()
    if (!endpoint) return
    try {
      const browser = await this.browserApi.connect({ browserWSEndpoint: endpoint })
      await browser.close().catch(() => undefined)
    } catch {
      // A stale port file is harmless; a later launch may replace it.
    }
  }

  private async pollForProfileBrowser(): Promise<{ browser: Browser | null; endpointSeen: boolean }> {
    const deadline = Date.now() + this.recoveryTimeoutMs
    let endpointSeen = false
    do {
      const endpoint = await this.readProfileEndpoint()
      if (endpoint) {
        endpointSeen = true
        try {
          return { browser: await this.browserApi.connect({ browserWSEndpoint: endpoint }), endpointSeen }
        } catch {
          // Edge may write the endpoint before it starts accepting connections.
        }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await delay(Math.min(this.recoveryPollMs, remaining))
    } while (Date.now() <= deadline)
    return { browser: null, endpointSeen }
  }

  private async readProfileEndpoint(): Promise<string | null> {
    try {
      const content = await readFile(join(this.paths.browserProfileDir, 'DevToolsActivePort'), 'utf8')
      const [portText, pathText] = content.split(/\r?\n/, 2).map((line) => line.trim())
      if (!/^\d{1,5}$/.test(portText) || !DEVTOOLS_PATH.test(pathText)) return null
      const port = Number(portText)
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
      return `ws://127.0.0.1:${port}${pathText}`
    } catch {
      return null
    }
  }

  private async downloadCandidate(
    candidate: Candidate, current: number, total: number, multiple: boolean, outputDir: string, title: string,
    referer: string, signal: AbortSignal,
    progress: (current: number, total: number, downloaded: number, itemTotal: number) => void,
  ): Promise<string> {
    let lastError: unknown = null
    for (const url of candidate.urls) {
      if (signal.aborted) throw new DownloadCancelled('下载已取消')
      let response: Response
      try {
        response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Referer: referer }, signal })
      } catch (error) {
        if (signal.aborted) throw new DownloadCancelled('下载已取消')
        lastError = error
        continue
      }
      const contentType = response.headers.get('content-type') || ''
      if (!response.ok || !response.body || !matchesKind(contentType, candidate.kind)) {
        await response.body?.cancel().catch(() => undefined)
        lastError = new Error(`媒体请求失败 (${response.status})`)
        continue
      }
      const extension = extensionFor(url, contentType, candidate.kind)
      const suffix = `_${String(multiple ? candidate.sequence : 1).padStart(2, '0')}`
      const path = await uniquePath(join(outputDir, `${title}${suffix}${extension}`))
      return this.writeStream(response, path, current, total, signal, progress)
    }
    throw lastError instanceof Error ? lastError : new Error('媒体请求失败')
  }

  private async writeStream(
    response: Response, path: string, current: number, total: number, signal: AbortSignal,
    progress: (current: number, total: number, downloaded: number, itemTotal: number) => void,
  ): Promise<string> {
    const partial = `${path}.part`
    const file = await open(partial, 'w')
    const reader = response.body!.getReader()
    const itemTotal = Number(response.headers.get('content-length') || 0)
    let downloaded = 0
    try {
      while (true) {
        if (signal.aborted) throw new DownloadCancelled('下载已取消')
        const { done, value } = await reader.read()
        if (done) break
        await file.write(value)
        downloaded += value.byteLength
        progress(current, total, downloaded, itemTotal)
      }
      await file.close()
      await rename(partial, path)
      return path
    } catch (error) {
      await file.close().catch(() => undefined)
      await unlink(partial).catch(() => undefined)
      throw error
    }
  }
}

function isProfileLockError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /profile|processsingleton|user\s*data\s*dir|already running/i.test(text)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function safeName(value: unknown, fallback: string): string {
  return String(value).trim().slice(0, 80).replace(/[<>:"/\\|?*\r\n]+/g, '_').replace(/[ .]+$/, '') || fallback
}

/** Rejects HTML error pages and mismatched media served with a 200 status. */
function matchesKind(contentType: string, kind: 'image' | 'video'): boolean {
  const type = contentType.toLowerCase()
  if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) return false
  const other = kind === 'image' ? 'video/' : 'image/'
  return !type.startsWith(other)
}

function extensionFor(url: string, contentType: string, kind: 'image' | 'video'): string {
  const extension = extname(new URL(url).pathname).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.webp'].includes(extension)) return extension
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
  if (contentType.includes('webp')) return '.webp'
  return kind === 'video' ? '.mp4' : '.bin'
}

async function uniquePath(path: string): Promise<string> {
  if (!(await exists(path)) && !(await exists(`${path}.part`))) return path
  const extension = extname(path)
  const stem = basename(path, extension)
  const directory = path.slice(0, path.length - basename(path).length)
  for (let number = 2; number < 10_000; number += 1) {
    const candidate = join(directory, `${stem} (${number})${extension}`)
    if (!(await exists(candidate)) && !(await exists(`${candidate}.part`))) return candidate
  }
  throw new Error('无法生成不冲突的文件名')
}
