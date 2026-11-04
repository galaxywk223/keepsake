import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { MediaViewer } from './MediaViewer'
import type { Collection } from '../types'

const collection: Collection = {
  id: 'a'.repeat(32), platform: 'douyin', aweme_id: '123', source_url: 'https://www.douyin.com/video/123', title: '测试视频',
  author: '作者', media_type: 'video', item_count: 1, imported: false, source_created_at: null,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', cover_asset_id: 'b'.repeat(32), total_size: 10,
  assets: [{ id: 'b'.repeat(32), filename: '测试视频.mp4', kind: 'video', mime_type: 'video/mp4', extension: 'mp4', size: 10, width: null, height: null, duration: null, sequence: 1 }],
}

beforeEach(() => {
  window.originalMedia = {
    collection: vi.fn(async () => collection),
    extractAudio: vi.fn(async () => collection),
  } as unknown as typeof window.originalMedia
})

test('extracts audio from the active video asset', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MediaViewer collectionId={collection.id} onClose={vi.fn()} /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '提取音频' }))
  await waitFor(() => expect(window.originalMedia.extractAudio).toHaveBeenCalledWith(collection.id, collection.assets![0].id))
})
