export type PageId = 'download' | 'library' | 'tasks'

export type Platform = 'douyin' | 'xiaohongshu'

export type UpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  current_version: string
  available_version: string | null
  download_percent: number | null
  message: string | null
}

export interface ParsedSource {
  url: string
  platform: Platform
  aweme_id: string | null
  duplicate: boolean
  existing_collection_id: string | null
}

export interface Job {
  id: string
  source_url: string
  platform: Platform
  aweme_id: string | null
  title: string | null
  status: string
  progress: number
  downloaded_bytes: number
  total_bytes: number
  current_item: number
  total_items: number
  error: string | null
  collection_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface Asset {
  id: string
  filename: string
  kind: 'image' | 'video' | 'audio'
  mime_type: string
  extension: string
  size: number
  width: number | null
  height: number | null
  duration: number | null
  sequence: number
}

export interface Collection {
  id: string
  platform: Platform
  aweme_id: string | null
  source_url: string | null
  title: string
  author: string | null
  media_type: 'image' | 'video' | 'audio' | 'mixed'
  item_count: number
  imported: boolean
  source_created_at: string | null
  created_at: string
  updated_at: string
  cover_asset_id: string | null
  total_size: number
  assets: Asset[] | null
}

export interface LibraryResult {
  items: Collection[]
  total: number
}

export interface Settings {
  download_dir: string
  browser_profile_ready: boolean
  browser_ready: boolean
  app_version: string
}
