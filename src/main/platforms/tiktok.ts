import type { Page } from 'puppeteer-core'
import { cookieHeader, delay, DownloadCancelled, followRedirects, hostMatches, type Candidate, type SiteDetail, type SiteExtractor } from './types'

const HOSTS = ['tiktok.com'] as const
const ITEM_PATTERN = /\/(?:@[^/]*\/(?:video|photo)|v|embed(?:\/v2)?)\/(\d{8,})(?:[/?#.]|$)/
const CAPTURE_TIMEOUT_MS = 60_000
const POLL_MS = 300

export const TIKTOK_UNAVAILABLE = 'TikTok 作品无法访问：可能已删除、设为私密，或者需要登录后才能观看'
export const TIKTOK_UNREACHABLE = '无法打开 TikTok，请确认当前网络可以访问 tiktok.com'

function extractId(url: string): string | null {
  if (!hostMatches(url, HOSTS)) return null
  return new URL(url).pathname.match(ITEM_PATTERN)?.[1] ?? null
}

export function canonicalItemUrl(url: string): string {
  const id = extractId(url)
  if (!id) return url
  const path = new URL(url).pathname
  const user = path.match(/^\/(@[^/]+)\//)?.[1] ?? '@'
  const kind = /\/photo\//.test(path) ? 'photo' : 'video'
  return `https://www.tiktok.com/${user}/${kind}/${id}`
}

function urlList(value: any): string[] {
  const list = Array.isArray(value?.UrlList) ? value.UrlList : Array.isArray(value?.urlList) ? value.urlList : []
  return list.filter(Boolean).map(String)
}

/**
 * Orders video sources: H.264 variants by bitrate first (plays everywhere on Windows), then the default play
 * address, then H.265 variants. `downloadAddr` comes last because it may carry a watermark.
 */
export function tiktokCandidates(item: Record<string, any>): Candidate[] {
  const images = item.imagePost?.images
  if (Array.isArray(images) && images.length) {
    return images.flatMap((image: any, index: number): Candidate[] => {
      const urls = urlList(image?.imageURL)
      return urls.length ? [{ urls, kind: 'image', sequence: index + 1 }] : []
    })
  }
  const video = item.video ?? {}
  const variants = Array.isArray(video.bitrateInfo) ? [...video.bitrateInfo] : []
  const isHevc = (variant: any) => /265|hev|hvc/i.test(String(variant?.CodecType ?? ''))
  const byBitrate = (a: any, b: any) => Number(b?.Bitrate || 0) - Number(a?.Bitrate || 0)
  const h264 = variants.filter((variant) => !isHevc(variant)).sort(byBitrate).flatMap((variant) => urlList(variant?.PlayAddr))
  const hevc = variants.filter(isHevc).sort(byBitrate).flatMap((variant) => urlList(variant?.PlayAddr))
  const urls = [...new Set([...h264, ...(video.playAddr ? [String(video.playAddr)] : []), ...hevc,
    ...(video.downloadAddr ? [String(video.downloadAddr)] : [])])]
  return urls.length ? [{ urls, kind: 'video', sequence: 1 }] : []
}

export function tiktokDetail(item: Record<string, any>): SiteDetail {
  const created = Number(item.createTime)
  const desc = typeof item.desc === 'string' ? item.desc.trim() : ''
  // Many captions are only hashtags; drop them so the title stays readable.
  const caption = desc.replace(/(^|\s)#\S+/g, ' ').replace(/\s+/g, ' ').trim()
  const author = item.author?.nickname || item.author?.uniqueId
  return {
    id: typeof item.id === 'string' ? item.id : null,
    title: (caption || desc.replace(/\s+/g, ' ')).slice(0, 80) || null,
    author: typeof author === 'string' ? author : null,
    createdAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : null,
    candidates: tiktokCandidates(item),
  }
}

type ReadResult = { item: Record<string, any> } | { status: number } | null

async function readItem(page: Page): Promise<ReadResult> {
  return page.evaluate(() => {
    const element = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
    if (!element?.textContent) return null
    const detail = JSON.parse(element.textContent)?.__DEFAULT_SCOPE__?.['webapp.video-detail']
    if (!detail) return null
    const item = detail.itemInfo?.itemStruct
    if (item?.id) return { item }
    return typeof detail.statusCode === 'number' && detail.statusCode !== 0 ? { status: detail.statusCode } : null
  }) as Promise<ReadResult>
}

async function capture(page: Page, url: string, signal: AbortSignal): Promise<SiteDetail> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CAPTURE_TIMEOUT_MS })
  } catch (error) {
    if (signal.aborted) throw new DownloadCancelled('下载已取消')
    throw new Error(TIKTOK_UNREACHABLE, { cause: error })
  }
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DownloadCancelled('下载已取消')
    const result = await readItem(page).catch(() => null)
    if (result && 'status' in result) throw new Error(TIKTOK_UNAVAILABLE)
    if (result && 'item' in result) {
      const detail = tiktokDetail(result.item)
      // The CDN rejects media requests without the page's cookies (tt_chain_token).
      const cookie = await cookieHeader(page, HOSTS)
      return cookie ? { ...detail, headers: { Cookie: cookie } } : detail
    }
    await delay(POLL_MS)
  }
  throw new Error(TIKTOK_UNAVAILABLE)
}

export const tiktok: SiteExtractor = {
  platform: 'tiktok',
  label: 'TikTok',
  hosts: HOSTS,
  homeUrl: 'https://www.tiktok.com/',
  referer: 'https://www.tiktok.com/',
  extractId,
  async normalize(value) {
    let url = value.trim()
    if (!extractId(url)) url = await followRedirects(url)
    return canonicalItemUrl(url)
  },
  capture,
}
