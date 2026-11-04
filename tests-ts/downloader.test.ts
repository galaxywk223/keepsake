// @vitest-environment node

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'puppeteer-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  BrowserDownloader,
  BrowserProfileRecoveryError,
  DownloadCancelled,
  type BrowserApi,
} from '../src/main/downloader'
import { friendlyError } from '../src/main/jobs'
import type { AppPaths } from '../src/main/paths'

const temporaryDirectories: string[] = []

class FakePage extends EventEmitter {
  setUserAgent = vi.fn(async () => undefined)
  goto = vi.fn(async () => undefined)
}

class FakeBrowser extends EventEmitter {
  connected = true
  close = vi.fn(async () => {
    this.connected = false
    this.emit('disconnected')
  })
  newPage = vi.fn(async () => this.page)

  constructor(readonly page = new FakePage()) {
    super()
  }

  pages = vi.fn(async () => [this.page])
}

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function createPaths(): Promise<AppPaths> {
  const root = await mkdtemp(join(tmpdir(), 'media-downloader-test-'))
  temporaryDirectories.push(root)
  const browserProfileDir = join(root, 'browser-profile')
  await mkdir(join(browserProfileDir, 'Default'), { recursive: true })
  return {
    root,
    dataDir: root,
    database: join(root, 'library.db'),
    thumbnailDir: join(root, 'thumbnails'),
    browserProfileDir,
    defaultDownloadDir: join(root, 'downloads'),
  }
}

async function writeEndpoint(paths: AppPaths, port = 9222, path = '/devtools/browser/test-id'): Promise<void> {
  await writeFile(join(paths.browserProfileDir, 'DevToolsActivePort'), `${port}\n${path}\n`, 'utf8')
}

function createDownloader(paths: AppPaths, browserApi: BrowserApi, recoveryTimeoutMs = 20): BrowserDownloader {
  const downloader = new BrowserDownloader(paths, { browserApi, recoveryTimeoutMs, recoveryPollMs: 1 })
  vi.spyOn(downloader, 'browserExecutable').mockReturnValue('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')
  return downloader
}

function asBrowser(browser: FakeBrowser): Browser {
  return browser as unknown as Browser
}

describe('BrowserDownloader profile recovery', () => {
  test('keeps an explicitly tracked login window open and blocks downloads', async () => {
    const paths = await createPaths()
    const login = new FakeBrowser()
    const browserApi: BrowserApi = {
      connect: vi.fn(async () => asBrowser(new FakeBrowser())),
      launch: vi.fn(async () => asBrowser(login)),
    }
    const downloader = createDownloader(paths, browserApi)
    await downloader.openLogin(() => undefined)

    await expect(downloader.download(
      'https://www.douyin.com/video/123',
      paths.defaultDownloadDir,
      new AbortController().signal,
      () => undefined,
    )).rejects.toThrow('登录浏览器仍在运行，请关闭后重试')

    expect(login.close).not.toHaveBeenCalled()
    expect(browserApi.launch).toHaveBeenCalledOnce()
    expect(browserApi.connect).not.toHaveBeenCalled()
  })

  test('does not launch a browser before the login profile is configured', async () => {
    const paths = await createPaths()
    await rm(join(paths.browserProfileDir, 'Default'), { recursive: true, force: true })
    const browserApi: BrowserApi = {
      connect: vi.fn(async () => asBrowser(new FakeBrowser())),
      launch: vi.fn(async () => asBrowser(new FakeBrowser())),
    }
    const downloader = createDownloader(paths, browserApi)

    await expect(downloader.download(
      'https://www.douyin.com/video/123',
      paths.defaultDownloadDir,
      new AbortController().signal,
      () => undefined,
    )).rejects.toThrow('需要先打开登录浏览器并完成登录')

    expect(browserApi.launch).not.toHaveBeenCalled()
    expect(browserApi.connect).not.toHaveBeenCalled()
  })

  test('closes a stale app-profile browser before launching', async () => {
    const paths = await createPaths()
    await writeEndpoint(paths)
    const stale = new FakeBrowser()
    const launched = new FakeBrowser()
    const browserApi: BrowserApi = {
      connect: vi.fn(async () => asBrowser(stale)),
      launch: vi.fn(async () => asBrowser(launched)),
    }
    const downloader = createDownloader(paths, browserApi)

    await downloader.openLogin(() => undefined)

    expect(browserApi.connect).toHaveBeenCalledWith({
      browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
    })
    expect(stale.close).toHaveBeenCalledOnce()
    expect(stale.close.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(browserApi.launch).mock.invocationCallOrder[0],
    )
    expect(downloader.loginOpen()).toBe(true)
  })

  test('attaches when launch rejects after starting the browser', async () => {
    const paths = await createPaths()
    const recovered = new FakeBrowser()
    const browserApi: BrowserApi = {
      connect: vi.fn(async () => asBrowser(recovered)),
      launch: vi.fn(async () => {
        await writeEndpoint(paths, 64606, '/devtools/browser/recovered-id')
        throw new Error('Failed to launch the browser process')
      }),
    }
    const downloader = createDownloader(paths, browserApi)

    await downloader.openLogin(() => undefined)

    expect(browserApi.connect).toHaveBeenCalledWith({
      browserWSEndpoint: 'ws://127.0.0.1:64606/devtools/browser/recovered-id',
    })
    expect(downloader.loginOpen()).toBe(true)
  })

  test('ignores invalid or non-browser endpoints', async () => {
    const paths = await createPaths()
    await writeEndpoint(paths, 9222, '/devtools/page/../../remote')
    const launched = new FakeBrowser()
    const browserApi: BrowserApi = {
      connect: vi.fn(async () => asBrowser(new FakeBrowser())),
      launch: vi.fn(async () => asBrowser(launched)),
    }
    const downloader = createDownloader(paths, browserApi)

    await downloader.openLogin(() => undefined)

    expect(browserApi.connect).not.toHaveBeenCalled()
    expect(browserApi.launch).toHaveBeenCalledOnce()
  })

  test('reports a dedicated recovery error when the app-profile endpoint cannot connect', async () => {
    const paths = await createPaths()
    const browserApi: BrowserApi = {
      connect: vi.fn(async () => { throw new Error('ECONNREFUSED') }),
      launch: vi.fn(async () => {
        await writeEndpoint(paths)
        throw new Error('The browser is already running for the profile')
      }),
    }
    const downloader = createDownloader(paths, browserApi, 5)

    await expect(downloader.openLogin(() => undefined)).rejects.toBeInstanceOf(BrowserProfileRecoveryError)
    await expect(downloader.openLogin(() => undefined)).rejects.toThrow(
      '后台浏览器占用登录环境且无法自动接管，请重启应用后重试',
    )
  })

  test.each(['success', 'failure', 'cancel'] as const)('cleans the profile after download %s', async (outcome) => {
    const paths = await createPaths()
    const page = new FakePage()
    const running = new FakeBrowser(page)
    const cleanup = new FakeBrowser()
    let endpointActive = false
    const browserApi: BrowserApi = {
      launch: vi.fn(async () => {
        endpointActive = true
        await writeEndpoint(paths)
        return asBrowser(running)
      }),
      connect: vi.fn(async () => {
        if (!endpointActive) throw new Error('not running')
        endpointActive = false
        return asBrowser(cleanup)
      }),
    }
    const downloader = createDownloader(paths, browserApi)
    const controller = new AbortController()
    page.goto.mockImplementation(async () => {
      if (outcome === 'cancel') {
        controller.abort()
        return
      }
      page.emit('response', {
        url: () => 'https://www.douyin.com/aweme/v1/web/aweme/detail/',
        json: async () => ({
          aweme_detail: outcome === 'success'
            ? { aweme_id: '123', desc: 'test', video: { play_addr: { url_list: ['https://media.test/video.mp4'] } } }
            : { aweme_id: '123', desc: 'test' },
        }),
      })
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'video/mp4', 'content-length': '3' },
    })))

    const result = downloader.download(
      'https://www.douyin.com/video/123',
      paths.defaultDownloadDir,
      controller.signal,
      () => undefined,
    )
    if (outcome === 'success') await expect(result).resolves.toMatchObject({ awemeId: '123' })
    if (outcome === 'failure') await expect(result).rejects.toThrow('页面详情中没有找到原始媒体')
    if (outcome === 'cancel') await expect(result).rejects.toBeInstanceOf(DownloadCancelled)

    expect(running.close).toHaveBeenCalledOnce()
    expect(cleanup.close).toHaveBeenCalledOnce()
    expect(browserApi.connect).toHaveBeenCalledWith({
      browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test-id',
    })
  })

  test('downloads Xiaohongshu live photos as paired files and falls back between URLs', async () => {
    const paths = await createPaths()
    const noteId = '6720a3f0000000001b0123ab'
    const page = Object.assign(new FakePage(), {
      url: vi.fn(() => `https://www.xiaohongshu.com/explore/${noteId}`),
      evaluate: vi.fn(async () => ({
        noteId, type: 'normal', title: '实况笔记', user: { nickname: '作者' },
        imageList: [
          { urlDefault: 'https://sns-webpic-qc.xhscdn.com/202611041200/abcdef/tokenone!nd_dft_wlteh_webp_3' },
          {
            urlDefault: 'https://sns-webpic-qc.xhscdn.com/202611041200/abcdef/tokentwo!nd_dft_wlteh_webp_3',
            livePhoto: true, stream: { h264: [{ masterUrl: 'https://video.test/live.mp4' }] },
          },
        ],
      })),
    })
    const browserApi: BrowserApi = {
      launch: vi.fn(async () => asBrowser(new FakeBrowser(page))),
      connect: vi.fn(async () => { throw new Error('not running') }),
    }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Referer).toBe('https://www.xiaohongshu.com/')
      if (url.startsWith('https://sns-img-bd.xhscdn.com/tokenone')) return new Response('missing', { status: 404 })
      if (url.startsWith('https://sns-img-bd.xhscdn.com/tokentwo')) {
        return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
      }
      const video = url.endsWith('.mp4')
      return new Response(new Uint8Array([1, 2]), {
        status: 200, headers: { 'content-type': video ? 'video/mp4' : 'image/jpeg', 'content-length': '2' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createDownloader(paths, browserApi).download(
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=t`,
      paths.defaultDownloadDir,
      new AbortController().signal,
      () => undefined,
    )

    expect(result).toMatchObject({ platform: 'xiaohongshu', awemeId: noteId, author: '作者' })
    expect(result.paths.map((path) => path.split(/[\\/]/).at(-1))).toEqual([
      '实况笔记_01.jpg', '实况笔记_02.jpg', '实况笔记_02.mp4',
    ])
  })

  test('maps the Xiaohongshu login wall to its own message', () => {
    expect(friendlyError(new Error('需要登录小红书或完成验证，请打开登录浏览器处理')))
      .toBe('需要登录小红书或完成验证，请打开登录浏览器处理')
  })

  test('keeps visible-login and background-profile errors distinct', () => {
    expect(friendlyError(new Error('登录浏览器仍在运行，请关闭后重试')))
      .toBe('登录浏览器仍在运行，请关闭后重试')
    expect(friendlyError(new Error('Failed to create ProcessSingleton for profile')))
      .toBe('后台浏览器占用登录环境且无法自动接管，请重启应用后重试')
    expect(friendlyError(new Error('UNIQUE constraint failed: media_assets.path')))
      .toBe('媒体文件已存在于媒体库，未自动合并')
  })
})
