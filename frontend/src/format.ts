import type { Platform } from './types'

const PLATFORM_LABELS: Record<Platform, { name: string; work: string }> = {
  douyin: { name: '抖音', work: '抖音作品' },
  xiaohongshu: { name: '小红书', work: '小红书笔记' },
}

export function platformLabel(platform: Platform | null | undefined): string {
  return PLATFORM_LABELS[platform ?? 'douyin']?.name ?? '未知来源'
}

export function workLabel(platform: Platform | null | undefined, id: string | null): string {
  const label = PLATFORM_LABELS[platform ?? 'douyin']?.work ?? '作品'
  return id ? `${label} ${id}` : `${platformLabel(platform)}分享链接`
}

export function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}
