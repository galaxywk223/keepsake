import type { Platform } from '../../shared/contracts'
import { bilibili } from './bilibili'
import { douyin } from './douyin'
import { tiktok } from './tiktok'
import { hostMatches, type SiteExtractor } from './types'
import { xiaohongshu } from './xiaohongshu'

export const extractors: readonly SiteExtractor[] = [douyin, xiaohongshu, bilibili, tiktok]

export function extractorFor(url: string): SiteExtractor | null {
  return extractors.find((extractor) => hostMatches(url, extractor.hosts)) ?? null
}

export function extractorById(platform: Platform): SiteExtractor {
  const extractor = extractors.find((item) => item.platform === platform)
  if (!extractor) throw new Error(`未知平台：${platform}`)
  return extractor
}

export type { Candidate, SiteDetail, SiteExtractor } from './types'
export { DownloadCancelled } from './types'
