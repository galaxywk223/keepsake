import type { Page } from 'puppeteer-core'
import type { Platform } from '../../shared/contracts'

export type { Platform }

export interface Candidate {
  /** Ordered download URLs; later entries are fallbacks for the same file. */
  urls: string[]
  kind: 'image' | 'video'
  /** File sequence used in the `_NN` filename suffix. Live photo pairs share one sequence. */
  sequence: number
  /** Separate audio stream (DASH); when set, `urls` is video-only and both are merged into one MP4. */
  audioUrls?: string[]
}

export interface SiteDetail {
  id: string | null
  title: string | null
  author: string | null
  createdAt: string | null
  candidates: Candidate[]
  /** Extra request headers for media downloads, e.g. the page's cookies when the CDN requires them. */
  headers?: Record<string, string>
}

export interface SiteExtractor {
  readonly platform: Platform
  readonly label: string
  readonly hosts: readonly string[]
  readonly homeUrl: string
  readonly referer: string
  /** Returns the work id when the URL already contains one. */
  extractId(url: string): string | null
  /** Resolves short links and returns the canonical page URL to open. */
  normalize(url: string): Promise<string>
  /** Opens `url` in `page` and returns the work detail captured from it. */
  capture(page: Page, url: string, signal: AbortSignal): Promise<SiteDetail>
}

export class DownloadCancelled extends Error {}

export function hostMatches(value: string, hosts: readonly string[]): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase()
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

export async function followRedirects(url: string): Promise<string> {
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
    return response.url || url
  } catch {
    // The browser resolves the link again when the page is opened.
    return url
  }
}

/** Builds a Cookie header from the browser's cookies for the given site domains. */
export async function cookieHeader(page: Page, domains: readonly string[]): Promise<string | null> {
  try {
    const cookies = await page.browser().cookies()
    const matching = cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase()
      return domains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`))
    })
    return matching.length ? matching.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') : null
  } catch {
    return null
  }
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
