import type { Page } from 'puppeteer-core'
import { DownloadCancelled, followRedirects, hostMatches, type Candidate, type SiteDetail, type SiteExtractor } from './types'

const HOSTS = ['douyin.com', 'iesdouyin.com'] as const
const AWEME_PATTERN = /\/(?:note|video|share\/video)\/(\d+)/
const DETAIL_PATH = '/aweme/v1/web/aweme/detail/'

function extractId(url: string): string | null {
  if (!hostMatches(url, HOSTS)) return null
  return new URL(url).pathname.match(AWEME_PATTERN)?.[1] ?? null
}

export function douyinCandidates(detail: Record<string, any>): Candidate[] {
  if (Array.isArray(detail.images) && detail.images.length) {
    return detail.images.flatMap((image: any, index: number) => {
      const urls = image?.download_url_list || image?.url_list
      return Array.isArray(urls) && urls[0]
        ? [{ urls: urls.map(String), kind: 'image' as const, sequence: index + 1 }]
        : []
    })
  }
  const video = detail.video
  for (const key of ['play_addr', 'download_addr']) {
    const urls = video?.[key]?.url_list || video?.[key]?.download_url_list
    if (Array.isArray(urls) && urls[0]) return [{ urls: urls.map(String), kind: 'video', sequence: 1 }]
  }
  return []
}

async function capture(page: Page, url: string, signal: AbortSignal): Promise<SiteDetail> {
  const detailPromise = new Promise<Record<string, any>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('页面未返回媒体详情，登录状态可能已失效')), 60_000)
    const abort = () => { clearTimeout(timeout); reject(new DownloadCancelled('下载已取消')) }
    signal.addEventListener('abort', abort, { once: true })
    page.on('response', async (response) => {
      if (!response.url().includes(DETAIL_PATH)) return
      try {
        const data = await response.json() as { aweme_detail?: Record<string, any> }
        if (data.aweme_detail) {
          clearTimeout(timeout)
          signal.removeEventListener('abort', abort)
          resolve(data.aweme_detail)
        }
      } catch { /* another response may contain the detail */ }
    })
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const detail = await detailPromise
  return {
    id: String(detail.aweme_id || extractId(url) || '') || null,
    title: typeof detail.desc === 'string' ? detail.desc : null,
    author: typeof detail.author?.nickname === 'string' ? detail.author.nickname : null,
    createdAt: typeof detail.create_time === 'number' ? new Date(detail.create_time * 1000).toISOString() : null,
    candidates: douyinCandidates(detail),
  }
}

export const douyin: SiteExtractor = {
  platform: 'douyin',
  label: '抖音',
  hosts: HOSTS,
  homeUrl: 'https://www.douyin.com/',
  referer: 'https://www.douyin.com/',
  extractId,
  async normalize(value) {
    let url = value.trim()
    if (!extractId(url)) url = await followRedirects(url)
    const id = extractId(url)
    return id ? `https://www.douyin.com/video/${id}` : url
  },
  capture,
}
