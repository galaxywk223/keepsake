import type { HTTPResponse, Page } from 'puppeteer-core'
import { delay, DownloadCancelled, followRedirects, hostMatches, type Candidate, type SiteDetail, type SiteExtractor } from './types'

const HOSTS = ['bilibili.com', 'b23.tv'] as const
const VIDEO_PATTERN = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)(?:[/?#]|$)/i
const PLAYURL_PATHS = ['/x/player/wbi/playurl', '/x/player/playurl'] as const
const CAPTURE_TIMEOUT_MS = 60_000
const POLL_MS = 300
/** The player may retry a failed playurl request, so an error only counts once it has persisted this long. */
const ERROR_GRACE_MS = 10_000

export const BILI_UNAVAILABLE = 'B 站视频无法访问：可能已删除、需要大会员，或者需要登录后才能观看'

/** Codec preference for local playback on Windows: AVC, then HEVC, then AV1. */
const CODEC_RANK: Record<number, number> = { 7: 3, 12: 2, 13: 1 }

interface VideoRef { bvid: string; page: number }

function parseVideo(url: string): VideoRef | null {
  if (!hostMatches(url, HOSTS)) return null
  const parsed = new URL(url)
  const match = parsed.pathname.match(VIDEO_PATTERN)
  if (!match) return null
  const raw = match[1]
  const bvid = /^bv/i.test(raw) ? `BV${raw.slice(2)}` : raw.toLowerCase()
  const page = Number(parsed.searchParams.get('p') || 1)
  return { bvid, page: Number.isInteger(page) && page > 0 ? page : 1 }
}

/** Part 1 keeps the plain id so it matches links without `?p=`; later parts get a `_pN` suffix. */
function extractId(url: string): string | null {
  const video = parseVideo(url)
  return video ? (video.page > 1 ? `${video.bvid}_p${video.page}` : video.bvid) : null
}

export function canonicalVideoUrl(url: string): string {
  const video = parseVideo(url)
  if (!video) return url
  const target = new URL(`https://www.bilibili.com/video/${video.bvid}/`)
  if (video.page > 1) target.searchParams.set('p', String(video.page))
  return target.toString()
}

function urlsOf(stream: any): string[] {
  const urls = [stream?.baseUrl ?? stream?.base_url, ...(stream?.backupUrl ?? stream?.backup_url ?? [])]
  return [...new Set(urls.filter(Boolean).map(String).map((url) => url.replace(/^http:\/\//, 'https://')))]
}

/** Picks the highest quality video (preferring AVC) and the highest bitrate audio from a playurl response. */
export function bilibiliCandidates(playurl: Record<string, any>): Candidate[] {
  const dash = playurl?.dash
  if (dash && Array.isArray(dash.video) && dash.video.length) {
    const videos = [...dash.video].sort((a: any, b: any) =>
      Number(b.id) - Number(a.id)
      || (CODEC_RANK[Number(b.codecid)] ?? 0) - (CODEC_RANK[Number(a.codecid)] ?? 0)
      || Number(b.bandwidth) - Number(a.bandwidth))
    const best = videos[0]
    // Fall back to other codecs of the same quality when the preferred stream fails.
    const sameQuality = videos.filter((video: any) => video.id === best.id)
    const audios = [...(Array.isArray(dash.audio) ? dash.audio : [])].sort((a: any, b: any) => Number(b.bandwidth) - Number(a.bandwidth))
    const videoUrls = [...new Set(sameQuality.flatMap(urlsOf))]
    const audioUrls = [...new Set(audios.flatMap(urlsOf))]
    if (!videoUrls.length) return []
    return [{ urls: videoUrls, kind: 'video', sequence: 1, ...(audioUrls.length ? { audioUrls } : {}) }]
  }
  // Older or short videos may return a single progressive file.
  if (Array.isArray(playurl?.durl) && playurl.durl.length === 1) {
    const segment = playurl.durl[0]
    const urls = [segment?.url, ...(segment?.backup_url ?? [])].filter(Boolean).map(String)
    return urls.length ? [{ urls, kind: 'video', sequence: 1 }] : []
  }
  return []
}

export function bilibiliDetail(videoData: Record<string, any>, playurl: Record<string, any>, page: number): SiteDetail {
  const pages = Array.isArray(videoData.pages) ? videoData.pages : []
  const part = pages.find((item: any) => Number(item?.page) === page)
  const baseTitle = typeof videoData.title === 'string' ? videoData.title.trim() : ''
  const title = pages.length > 1 && part?.part ? `${baseTitle} - P${page} ${String(part.part).trim()}` : baseTitle
  const pubdate = Number(videoData.pubdate)
  const bvid = typeof videoData.bvid === 'string' ? videoData.bvid : null
  return {
    id: bvid ? (page > 1 ? `${bvid}_p${page}` : bvid) : null,
    title: title || null,
    author: typeof videoData.owner?.name === 'string' ? videoData.owner.name : null,
    createdAt: Number.isFinite(pubdate) && pubdate > 0 ? new Date(pubdate * 1000).toISOString() : null,
    candidates: bilibiliCandidates(playurl),
  }
}

async function readVideoData(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const data = (window as any).__INITIAL_STATE__?.videoData
    if (!data?.bvid) return null
    return {
      bvid: data.bvid, title: data.title, pubdate: data.pubdate, cid: data.cid,
      owner: { name: data.owner?.name },
      pages: Array.isArray(data.pages) ? data.pages.map((item: any) => ({ page: item.page, cid: item.cid, part: item.part })) : [],
    }
  }) as Promise<Record<string, any> | null>
}

async function readEmbeddedPlayinfo(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => {
    const info = (window as any).__playinfo__
    if (info?.code !== 0 || !info.data) return null
    const pick = (stream: any) => ({
      id: stream?.id, codecid: stream?.codecid, bandwidth: stream?.bandwidth,
      baseUrl: stream?.baseUrl ?? stream?.base_url, backupUrl: stream?.backupUrl ?? stream?.backup_url,
    })
    const data = info.data
    return {
      dash: data.dash ? { video: (data.dash.video ?? []).map(pick), audio: (data.dash.audio ?? []).map(pick) } : undefined,
      durl: Array.isArray(data.durl) ? data.durl.map((item: any) => ({ url: item?.url, backup_url: item?.backup_url })) : undefined,
    }
  }) as Promise<Record<string, any> | null>
}

/** Embedded playinfo has no cid field, but every stream URL contains it as a path segment. */
export function playinfoMatchesCid(playinfo: Record<string, any>, cid: string): boolean {
  if (!cid) return false
  const urls = [
    ...(playinfo.dash?.video ?? []).map((stream: any) => stream?.baseUrl),
    ...(playinfo.durl ?? []).map((item: any) => item?.url),
  ].filter(Boolean).map(String)
  return urls.length > 0 && urls.every((url) => url.includes(`/${cid}/`) || url.includes(`/${cid}-`))
}

async function capture(page: Page, url: string, signal: AbortSignal): Promise<SiteDetail> {
  const playurls = new Map<string, Record<string, any>>()
  let playurlError: { message: string; at: number } | null = null
  page.on('response', async (response: HTTPResponse) => {
    const responseUrl = response.url()
    if (!PLAYURL_PATHS.some((path) => responseUrl.includes(path))) return
    try {
      const body = await response.json() as { code?: number; message?: string; data?: Record<string, any> }
      const cid = new URL(responseUrl).searchParams.get('cid') ?? ''
      if (body.code === 0 && body.data) playurls.set(cid, body.data)
      else playurlError ??= { message: `${body.code ?? ''} ${body.message ?? ''}`.trim(), at: Date.now() }
    } catch { /* a later response may succeed */ }
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CAPTURE_TIMEOUT_MS })
  const wanted = parseVideo(url) ?? parseVideo(page.url())
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal.aborted) throw new DownloadCancelled('下载已取消')
    const videoData = await readVideoData(page).catch(() => null)
    if (videoData) {
      const pageNumber = wanted?.page ?? 1
      const cid = String(videoData.pages.find((item: any) => Number(item.page) === pageNumber)?.cid ?? videoData.cid ?? '')
      // Fresh profiles get playurl from the API; repeat visits often have it embedded in the page instead.
      const embedded = await readEmbeddedPlayinfo(page).catch(() => null)
      const playurl = playurls.get(cid) ?? playurls.get('')
        ?? (embedded && playinfoMatchesCid(embedded, cid) ? embedded : null)
      if (playurl) return bilibiliDetail(videoData, playurl, pageNumber)
    }
    const failure = playurlError as { message: string; at: number } | null
    if (failure && Date.now() - failure.at > ERROR_GRACE_MS) throw new Error(`${BILI_UNAVAILABLE}（${failure.message}）`)
    await delay(POLL_MS)
  }
  const failure = playurlError as { message: string; at: number } | null
  throw new Error(failure ? `${BILI_UNAVAILABLE}（${failure.message}）` : BILI_UNAVAILABLE)
}

export const bilibili: SiteExtractor = {
  platform: 'bilibili',
  label: 'B 站',
  hosts: HOSTS,
  homeUrl: 'https://www.bilibili.com/',
  referer: 'https://www.bilibili.com/',
  extractId,
  async normalize(value) {
    let url = value.trim()
    if (!parseVideo(url)) url = await followRedirects(url)
    return canonicalVideoUrl(url)
  },
  capture,
}
