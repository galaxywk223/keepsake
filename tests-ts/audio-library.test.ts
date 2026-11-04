// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { LibraryService, MediaPathConflictError } from '../src/main/library'
import type { AppPaths } from '../src/main/paths'

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: () => ({ getSize: () => ({ width: 0, height: 0 }) }),
    createThumbnailFromPath: async () => ({ isEmpty: () => true }),
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() },
}))

const contexts: Array<{ database: AppDatabase; paths: AppPaths }> = []

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    context.database.close()
    await rm(context.paths.root, { recursive: true, force: true })
  }
})

async function createContext() {
  const root = await mkdtemp(join(tmpdir(), 'oml-audio-library-'))
  const paths: AppPaths = {
    root, dataDir: root, database: join(root, 'library.db'), thumbnailDir: join(root, 'thumbnails'),
    browserProfileDir: join(root, 'browser-profile'), defaultDownloadDir: join(root, 'downloads'),
  }
  await mkdir(paths.thumbnailDir, { recursive: true })
  await mkdir(paths.defaultDownloadDir, { recursive: true })
  const database = new AppDatabase(paths.database)
  const library = new LibraryService(database, paths, vi.fn())
  contexts.push({ database, paths })
  return { database, library, paths }
}

test('registers extracted audio in the source collection and is idempotent', async () => {
  const { database, library, paths } = await createContext()
  const video = join(paths.defaultDownloadDir, '作品.mp4')
  await writeFile(video, Buffer.from('video'))
  const original = await library.addDownload({
    title: '作品', author: '作者', sourceUrl: 'https://www.douyin.com/video/123', awemeId: '123',
    sourceCreatedAt: null, paths: [video],
  })
  const sourceAsset = original.assets![0]
  const output = join(paths.defaultDownloadDir, '作品.mp3')
  let conversions = 0
  const converted = await library.addExtractedAudio(original.id, sourceAsset.id, paths.defaultDownloadDir, async (_source, target) => {
    conversions += 1
    await writeFile(target, Buffer.from('audio'))
  })
  const repeated = await library.addExtractedAudio(original.id, sourceAsset.id, paths.defaultDownloadDir, async () => { conversions += 1 })
  expect(converted.media_type).toBe('mixed')
  expect(converted.item_count).toBe(2)
  expect(converted.assets?.map((asset) => asset.kind)).toEqual(['video', 'audio'])
  expect(repeated.id).toBe(original.id)
  expect(conversions).toBe(1)
  expect(database.connection.prepare('SELECT path FROM media_assets WHERE kind = ?').get('audio')).toEqual({ path: output })
  expect(library.query({ search: '', media_type: 'audio', sort: 'newest' }).items.map((item) => item.id)).toContain(original.id)
})

test('rejects extraction from a non-video asset', async () => {
  const { library, paths } = await createContext()
  const image = join(paths.defaultDownloadDir, '图片.jpg')
  await writeFile(image, Buffer.from('image'))
  const collection = await library.addDownload({
    title: '图片', author: null, sourceUrl: 'https://www.douyin.com/video/456', awemeId: '456',
    sourceCreatedAt: null, paths: [image],
  })
  await expect(library.addExtractedAudio(collection.id, collection.assets![0].id, paths.defaultDownloadDir, vi.fn()))
    .rejects.toThrow('只能从视频提取音频')
})

test('rejects an output path already owned by another collection', async () => {
  const { library, paths } = await createContext()
  const firstVideo = join(paths.defaultDownloadDir, '同名.mp4')
  const secondVideo = join(paths.defaultDownloadDir, '其他.mp4')
  const existingAudio = join(paths.defaultDownloadDir, '同名.mp3')
  await Promise.all([writeFile(firstVideo, Buffer.from('a')), writeFile(secondVideo, Buffer.from('b')), writeFile(existingAudio, Buffer.from('audio'))])
  const first = await library.addDownload({ title: '一', author: null, sourceUrl: 'https://www.douyin.com/video/1', awemeId: '1', sourceCreatedAt: null, paths: [firstVideo] })
  await library.addDownload({ title: '二', author: null, sourceUrl: 'https://www.douyin.com/video/2', awemeId: '2', sourceCreatedAt: null, paths: [existingAudio] })
  await expect(library.addExtractedAudio(first.id, first.assets![0].id, paths.defaultDownloadDir, vi.fn())).rejects.toBeInstanceOf(MediaPathConflictError)
})

test('scopes duplicate detection and live photo pairs by platform', async () => {
  const { library, paths } = await createContext()
  const image = join(paths.defaultDownloadDir, '笔记_01.jpg')
  const live = join(paths.defaultDownloadDir, '笔记_01.mp4')
  await writeFile(image, Buffer.from('image'))
  await writeFile(live, Buffer.from('video'))
  const note = await library.addDownload({
    title: '笔记', author: null, sourceUrl: 'https://www.xiaohongshu.com/explore/abc', platform: 'xiaohongshu',
    awemeId: 'abc', sourceCreatedAt: null, paths: [image, live],
  })

  expect(note).toMatchObject({ platform: 'xiaohongshu', media_type: 'mixed', item_count: 2 })
  expect(library.duplicate('xiaohongshu', 'abc')?.id).toBe(note.id)
  expect(library.duplicate('douyin', 'abc')).toBeNull()
})
