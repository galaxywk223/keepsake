// @vitest-environment node

import { describe, expect, test } from 'vitest'
import { identifySource, normalizeSourceUrl } from '../src/main/parser'
import { bilibiliCandidates, bilibiliDetail, canonicalVideoUrl, playinfoMatchesCid } from '../src/main/platforms/bilibili'
import { canonicalItemUrl, tiktokCandidates, tiktokDetail } from '../src/main/platforms/tiktok'

const stream = (id: number, codecid: number, bandwidth: number, name: string) => ({
  id, codecid, bandwidth,
  baseUrl: `http://upos.bilivideo.com/upgcxcode/1/2/43270800926/43270800926-1-${name}.m4s?e=1`,
  backupUrl: [`https://backup.bilivideo.com/43270800926-1-${name}.m4s`],
})

describe('bilibili links', () => {
  test('identifies BV/av ids and keeps the part number', () => {
    expect(identifySource('https://www.bilibili.com/video/BV18x4M6rEFM/?share_source=copy_web'))
      .toEqual({ platform: 'bilibili', id: 'BV18x4M6rEFM' })
    expect(identifySource('https://m.bilibili.com/video/BV1RA4w6AE74?p=2')).toEqual({ platform: 'bilibili', id: 'BV1RA4w6AE74_p2' })
    expect(identifySource('https://www.bilibili.com/video/av170001')).toEqual({ platform: 'bilibili', id: 'av170001' })
    expect(identifySource('https://b23.tv/AbCd123')).toEqual({ platform: 'bilibili', id: null })
    expect(identifySource('https://www.bilibili.com/bangumi/play/ep1')).toEqual({ platform: 'bilibili', id: null })
  })

  test('canonicalizes and drops tracking parameters', async () => {
    expect(canonicalVideoUrl('https://www.bilibili.com/video/BV1RA4w6AE74?p=2&vd_source=x'))
      .toBe('https://www.bilibili.com/video/BV1RA4w6AE74/?p=2')
    expect(await normalizeSourceUrl('https://www.bilibili.com/video/BV18x4M6rEFM/?p=1&spm_id_from=a'))
      .toBe('https://www.bilibili.com/video/BV18x4M6rEFM/')
  })
})

describe('bilibili streams', () => {
  test('picks the highest quality, prefers AVC, and pairs the best audio', () => {
    const [candidate] = bilibiliCandidates({
      dash: {
        video: [stream(32, 12, 400, 'hevc480'), stream(32, 7, 700, 'avc480'), stream(16, 7, 500, 'avc360'), stream(32, 13, 350, 'av1480')],
        audio: [{ id: 30216, bandwidth: 60, baseUrl: 'https://a/low.m4s' }, { id: 30280, bandwidth: 150, baseUrl: 'https://a/high.m4s' }],
      },
    })
    expect(candidate.urls[0]).toContain('-avc480.m4s')
    expect(candidate.urls[0]).toMatch(/^https:/)
    expect(candidate.urls.some((url) => url.includes('avc360'))).toBe(false)
    expect(candidate.urls.findIndex((url) => url.includes('hevc480'))).toBeGreaterThan(candidate.urls.findIndex((url) => url.includes('avc480')))
    expect(candidate.audioUrls).toEqual(['https://a/high.m4s', 'https://a/low.m4s'])
  })

  test('uses a single progressive file when no DASH data is present', () => {
    expect(bilibiliCandidates({ durl: [{ url: 'https://v/whole.mp4', backup_url: ['https://b/whole.mp4'] }] })).toEqual([
      { urls: ['https://v/whole.mp4', 'https://b/whole.mp4'], kind: 'video', sequence: 1 },
    ])
    expect(bilibiliCandidates({ durl: [{ url: 'https://v/1.flv' }, { url: 'https://v/2.flv' }] })).toEqual([])
  })

  test('adds the part name to multi-part titles', () => {
    const detail = bilibiliDetail({
      bvid: 'BV1RA4w6AE74', title: '合集', pubdate: 1_793_671_200, owner: { name: 'UP' },
      pages: [{ page: 1, cid: 1, part: '第一段' }, { page: 2, cid: 2, part: '第二段' }],
    }, { dash: { video: [stream(32, 7, 1, 'v')], audio: [] } }, 2)
    expect(detail).toMatchObject({ id: 'BV1RA4w6AE74_p2', title: '合集 - P2 第二段', author: 'UP', createdAt: '2026-11-03T02:00:00.000Z' })
    expect(detail.candidates[0].audioUrls).toBeUndefined()
  })

  test('matches embedded playinfo to a part by the cid in its stream URLs', () => {
    const playinfo = { dash: { video: [stream(32, 7, 1, 'v')] } }
    expect(playinfoMatchesCid(playinfo, '43270800926')).toBe(true)
    expect(playinfoMatchesCid(playinfo, '43283448191')).toBe(false)
    expect(playinfoMatchesCid(playinfo, '')).toBe(false)
  })
})

describe('tiktok', () => {
  test('identifies video and photo links', () => {
    expect(identifySource('https://www.tiktok.com/@dogmeme93/video/7688727548670397704?is_from_webapp=1'))
      .toEqual({ platform: 'tiktok', id: '7688727548670397704' })
    expect(identifySource('https://www.tiktok.com/@a.b/photo/7300000000000000001')).toEqual({ platform: 'tiktok', id: '7300000000000000001' })
    expect(identifySource('https://vm.tiktok.com/ZMabc123/')).toEqual({ platform: 'tiktok', id: null })
    expect(canonicalItemUrl('https://www.tiktok.com/@a.b/photo/7300000000000000001?lang=en'))
      .toBe('https://www.tiktok.com/@a.b/photo/7300000000000000001')
  })

  test('orders H.264 by bitrate, then the play address, then H.265, with downloadAddr last', () => {
    const variant = (codec: string, bitrate: number, url: string) => ({ CodecType: codec, Bitrate: bitrate, PlayAddr: { UrlList: [url] } })
    const [candidate] = tiktokCandidates({
      video: {
        playAddr: 'https://v/play', downloadAddr: 'https://v/download',
        bitrateInfo: [variant('h265_hvc1', 900, 'https://v/hevc'), variant('h264', 300, 'https://v/low'), variant('h264', 700, 'https://v/high')],
      },
    })
    expect(candidate.urls).toEqual(['https://v/high', 'https://v/low', 'https://v/play', 'https://v/hevc', 'https://v/download'])
  })

  test('downloads photo posts as numbered images', () => {
    const candidates = tiktokCandidates({ imagePost: { images: [{ imageURL: { urlList: ['https://i/1.jpeg'] } }, { imageURL: { urlList: ['https://i/2.jpeg'] } }] } })
    expect(candidates.map((item) => [item.kind, item.sequence, item.urls[0]])).toEqual([['image', 1, 'https://i/1.jpeg'], ['image', 2, 'https://i/2.jpeg']])
  })

  test('keeps readable captions and falls back to hashtags', () => {
    expect(tiktokDetail({ id: '1', desc: 'Morning walk #dog #fyp', createTime: '1790171389', author: { nickname: 'n' } }))
      .toMatchObject({ title: 'Morning walk', author: 'n', createdAt: '2026-09-23T13:49:49.000Z' })
    expect(tiktokDetail({ id: '1', desc: '#viral  #fyp ' }).title).toBe('#viral #fyp')
  })
})
