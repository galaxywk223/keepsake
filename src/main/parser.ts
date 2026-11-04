import type { Platform } from '../shared/contracts'
import { extractorFor } from './platforms'

const URL_PATTERN = /https?:\/\/[^\s，。；、！!？?）)】\]]+/g

export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of text.match(URL_PATTERN) ?? []) {
    const url = raw.replace(/[.,;:]+$/, '')
    if (!seen.has(url)) {
      seen.add(url)
      result.push(url)
    }
  }
  return result
}

export function isSupportedSource(value: string): boolean {
  return extractorFor(value) !== null
}

export function platformOf(value: string): Platform | null {
  return extractorFor(value)?.platform ?? null
}

/** Work id for any supported platform (kept under its historical name). */
export function extractAwemeId(value: string): string | null {
  return extractorFor(value)?.extractId(value) ?? null
}

export function identifySource(value: string): { platform: Platform; id: string | null } | null {
  const extractor = extractorFor(value)
  return extractor ? { platform: extractor.platform, id: extractor.extractId(value) } : null
}

export async function normalizeSourceUrl(value: string): Promise<string> {
  const url = value.trim()
  const extractor = extractorFor(url)
  return extractor ? extractor.normalize(url) : url
}
