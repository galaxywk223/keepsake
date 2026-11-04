import type { HTTPResponse, Page } from 'puppeteer-core'
import { delay, DownloadCancelled, followRedirects, hostMatches, type Candidate, type SiteDetail, type SiteExtractor } from './types'

const HOSTS = ['xiaohongshu.com', 'xhslink.com'] as const
const NOTE_PATTERN = /\/(?:explore|discovery\/item|item)\/([0-9a-f]{24})(?:[/?#]|$)/i
const KEPT_PARAMS = ['xsec_token', 'xsec_source'] as const
const FEED_PATH = '/api/sns/web/v1/feed'
const CAPTURE_TIMEOUT_MS = 60_000
const POLL_MS = 500
const WARM_UP_MS = 8_000

export const XHS_LOGIN_REQUIRED = '需要登录小红书或完成验证，请打开登录浏览器处理'
export const XHS_UNAVAILABLE = '小红书笔记无法访问，请使用 App 中“分享 → 复制链接”得到的完整链接'

function extractId(url: string): string | null {
  if (!hostMatches(url, HOSTS)) return null
  return new URL(url).pathname.match(NOTE_PATTERN)?.[1]?.toLowerCase() ?? null
}

export function canonicalNoteUrl(url: string): string {
  const id = extractId(url)
  if (!id) return url
  const source = new URL(url)
  const target = new URL(`https://www.xiaohongshu.com/explore/${id}`)
  for (const key of KEPT_PARAMS) {
    const value = source.searchParams.get(key)
    if (value) target.searchParams.set(key, value)
  }
  return target.toString()
}

/** Returns why the current page cannot show the note, or null while it may still load. */
export function blockedReason(pageUrl: string): string | null {
  let path: string
  try { path = new URL(pageUrl).pathname.toLowerCase() } catch { return null }
  if (path.startsWith('/website-login') || path.startsWith('/login') || path.includes('captcha')) return XHS_LOGIN_REQUIRED
  if (path.startsWith('/404')) return XHS_UNAVAILABLE
  return null
}

/**
 * Stream groups are keyed by codec (`h264`, `h265`, ...) or by obfuscated keys (`EF4`, `EF5`, ...),
 * so every group is read. fMP4/DASH segments carry no audio and are skipped.
 */
function streamUrls(stream: any): string[] {
  if (!stream || typeof stream !== 'object') return []
  const variants = Object.values(stream).flatMap((group) => Array.isArray(group) ? group : [])
    .filter((variant: any) => {
      const url = String(variant?.masterUrl ?? '')
      return url && variant?.format !== 'fmp4' && !/\.m4s(?:[?#]|$)/i.test(url)
    })
  const score = (variant: any) => [
    Number(variant?.audioBitrate) > 0 || Boolean(variant?.audioCodec) || variant?.audioBitrate === undefined ? 1 : 0,
    String(variant?.videoCodec ?? '').toLowerCase() === 'h265' ? 0 : 1,
    Number(variant?.avgBitrate || 0),
  ]
  variants.sort((a: any, b: any) => {
    const left = score(a); const right = score(b)
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return right[index] - left[index]
    return 0
  })
  const urls: string[] = []
  for (const variant of variants as any[]) {
    urls.push(String(variant.masterUrl))
    if (Array.isArray(variant.backupUrls)) urls.push(...variant.backupUrls.map(String))
  }
  return unique(urls)
}

/** Image token after the `<timestamp>/<hash>/` prefix of a CDN URL, without the `!style` suffix. */
export function imageToken(url: string): string | null {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    if (parts.length < 3 || !/^\d{8,}$/.test(parts[0])) return null
    const token = parts.slice(2).join('/').split('!')[0]
    return token || null
  } catch {
    return null
  }
}

function imageUrls(image: any): string[] {
  const listed: string[] = []
  if (Array.isArray(image?.infoList)) {
    const preferred = image.infoList.find((info: any) => info?.imageScene === 'WB_DFT') ?? image.infoList.at(-1)
    if (preferred?.url) listed.push(String(preferred.url))
  }
  for (const key of ['urlDefault', 'url', 'urlPre']) if (image?.[key]) listed.push(String(image[key]))
  const token = listed.map(imageToken).find(Boolean)
  // Originals are stored as HEIC; ask the CDN for a lossless PNG at full size, then JPEG, then the listed WebP.
  const originals = token ? [
    `https://sns-img-bd.xhscdn.com/${token}?imageView2/format/png`,
    `https://ci.xiaohongshu.com/${token}?imageView2/format/png`,
    `https://sns-img-bd.xhscdn.com/${token}?imageView2/format/jpg`,
  ] : []
  return unique([...originals, ...listed].map(httpsUrl))
}

export function xiaohongshuCandidates(note: Record<string, any>): Candidate[] {
  if (note.type === 'video') {
    const originKey = note.video?.consumer?.originVideoKey
    const urls = unique([
      ...(originKey ? [`https://sns-video-bd.xhscdn.com/${originKey}`] : []),
      ...streamUrls(note.video?.media?.stream),
    ].map(httpsUrl))
    return urls.length ? [{ urls, kind: 'video', sequence: 1 }] : []
  }
  const images = Array.isArray(note.imageList) ? note.imageList : []
  return images.flatMap((image: any, index: number): Candidate[] => {
    const sequence = index + 1
    const result: Candidate[] = []
    const urls = imageUrls(image)
    if (urls.length) result.push({ urls, kind: 'image', sequence })
    if (image?.livePhoto) {
      const live = streamUrls(image.stream).map(httpsUrl)
      if (live.length) result.push({ urls: live, kind: 'video', sequence })
    }
    return result
  })
}

export function xiaohongshuDetail(note: Record<string, any>, fallbackId: string | null): SiteDetail {
  const title = typeof note.title === 'string' && note.title.trim() ? note.title.trim()
    : typeof note.desc === 'string' && note.desc.trim() ? note.desc.trim().slice(0, 80) : null
  const time = Number(note.time)
  return {
    id: typeof note.noteId === 'string' ? note.noteId : fallbackId,
    title,
    author: typeof note.user?.nickname === 'string' ? note.user.nickname : null,
    createdAt: Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null,
    candidates: xiaohongshuCandidates(note),
  }
}

async function readInitialState(page: Page, id: string | null): Promise<Record<string, any> | null> {
  return page.evaluate((noteId) => {
    const state = (window as any).__INITIAL_STATE__
    const map = state?.note?.noteDetailMap
    if (!map) return null
    const first = state?.note?.firstNoteId
    const firstId = typeof first === 'string' ? first : first?._value ?? first?.value
    const key = noteId && map[noteId] ? noteId
      : firstId && map[firstId] ? firstId : Object.keys(map).find((value) => value && value !== 'undefined')
    const note = key ? map[key]?.note : null
    if (!note || (!note.noteId && !note.imageList && !note.video)) return null
    // Vue reactive state can contain refs and dependency cycles, so plain JSON.stringify may throw.
    const seen = new WeakSet<object>()
    const clone = (value: any, depth: number): any => {
      if (value && typeof value === 'object' && '__v_isRef' in value) value = value._value
      if (value === null || typeof value !== 'object') return typeof value === 'function' ? undefined : value
      if (depth > 12 || seen.has(value)) return undefined
      seen.add(value)
      if (Array.isArray(value)) return value.map((item) => clone(item, depth + 1))
      const result: Record<string, any> = {}
      for (const [name, item] of Object.entries(value)) {
        if (name === 'dep' || name === 'deps' || name.startsWith('__v_')) continue
        result[name] = clone(item, depth + 1)
      }
      return result
    }
    return clone(note, 0)
  }, id) as Promise<Record<string, any> | null>
}

/** A blank profile lacks the guest session cookies, and some notes then redirect to 404. */
async function warmUp(page: Page): Promise<void> {
  await page.goto(xiaohongshu.homeUrl, { waitUntil: 'domcontentloaded', timeout: CAPTURE_TIMEOUT_MS })
  const deadline = Date.now() + WARM_UP_MS
  while (Date.now() < deadline) {
    if (await hasSession(page) !== false) return
    await delay(POLL_MS)
  }
}

/** True/false when cookies can be read; null when the page cannot report them. */
async function hasSession(page: Page): Promise<boolean | null> {
  try {
    const cookies = await page.browser().cookies()
    return cookies.some((cookie) => cookie.name === 'web_session' && cookie.domain.endsWith('xiaohongshu.com'))
  } catch {
    return null
  }
}

async function capture(page: Page, url: string, signal: AbortSignal): Promise<SiteDetail> {
  if (await hasSession(page) === false) await warmUp(page)
  if (signal.aborted) throw new DownloadCancelled('下载已取消')
  return captureNote(page, url, signal, true)
}

async function captureNote(page: Page, url: string, signal: AbortSignal, retry: boolean): Promise<SiteDetail> {
  let fromFeed: Record<string, any> | null = null
  page.on('response', async (response: HTTPResponse) => {
    if (fromFeed || !response.url().includes(FEED_PATH)) return
    try {
      const data = await response.json() as { data?: { items?: Array<{ id?: string; note_card?: Record<string, any> }> } }
      const item = data.data?.items?.[0]
      const expected = extractId(url)
      if (item?.note_card && (!expected || !item.id || item.id === expected)) {
        fromFeed = { note_id: item.id, ...item.note_card }
      }
    } catch { /* the initial state is the primary source */ }
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CAPTURE_TIMEOUT_MS })
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS
  let id = extractId(url)
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DownloadCancelled('下载已取消')
    const current = page.url()
    const blocked = blockedReason(current)
    if (blocked === XHS_UNAVAILABLE && retry) {
      page.removeAllListeners('response')
      await warmUp(page)
      if (signal.aborted) throw new DownloadCancelled('下载已取消')
      return captureNote(page, url, signal, false)
    }
    if (blocked) throw new Error(blocked)
    id = id ?? extractId(current)
    const note = fromFeed ?? await readInitialState(page, id).catch(() => null)
    if (note) return xiaohongshuDetail(fromFeed ? feedToNote(note) : note, id)
    await delay(POLL_MS)
  }
  throw new Error(new URL(url).searchParams.has('xsec_token') ? XHS_LOGIN_REQUIRED : XHS_UNAVAILABLE)
}

/** The feed API uses snake_case; map the fields the detail reader needs. */
export function feedToNote(card: Record<string, any>): Record<string, any> {
  return {
    noteId: card.note_id, type: card.type, title: card.title, desc: card.desc, time: card.time,
    user: { nickname: card.user?.nickname },
    imageList: Array.isArray(card.image_list) ? card.image_list.map((image: any) => ({
      urlDefault: image?.url_default, urlPre: image?.url_pre, url: image?.url,
      infoList: image?.info_list?.map((info: any) => ({ imageScene: info?.image_scene, url: info?.url })),
      livePhoto: image?.live_photo, stream: mapStream(image?.stream),
    })) : [],
    video: card.video ? {
      consumer: { originVideoKey: card.video.consumer?.origin_video_key },
      media: { stream: mapStream(card.video.media?.stream) },
    } : undefined,
  }
}

function mapStream(stream: any): any {
  if (!stream) return stream
  const map = (variants: any) => Array.isArray(variants) ? variants.map((variant: any) => ({
    masterUrl: variant?.master_url ?? variant?.masterUrl,
    backupUrls: variant?.backup_urls ?? variant?.backupUrls,
    avgBitrate: variant?.avg_bitrate ?? variant?.avgBitrate,
    audioBitrate: variant?.audio_bitrate ?? variant?.audioBitrate,
    audioCodec: variant?.audio_codec ?? variant?.audioCodec,
    videoCodec: variant?.video_codec ?? variant?.videoCodec,
    format: variant?.format,
  })) : []
  return Object.fromEntries(Object.entries(stream).map(([key, variants]) => [key, map(variants)]))
}

function httpsUrl(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

export const xiaohongshu: SiteExtractor = {
  platform: 'xiaohongshu',
  label: '小红书',
  hosts: HOSTS,
  homeUrl: 'https://www.xiaohongshu.com/explore',
  referer: 'https://www.xiaohongshu.com/',
  extractId,
  async normalize(value) {
    let url = value.trim()
    if (!extractId(url)) url = await followRedirects(url)
    return canonicalNoteUrl(url)
  },
  capture,
}
