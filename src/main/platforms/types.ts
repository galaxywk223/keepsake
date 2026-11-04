import type { Page } from 'puppeteer-core'
import type { Platform } from '../../shared/contracts'

export type { Platform }

export interface Candidate {
  /** Ordered download URLs; later entries are fallbacks for the same file. */
  urls: string[]
  kind: 'image' | 'video'
  /** File sequence used in the `_NN` filename suffix. Live photo pairs share one sequence. */
  sequence: number
}

export interface SiteDetail {
  id: string | null
  title: string | null
  author: string | null
  createdAt: string | null
  candidates: Candidate[]
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

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
