// @vitest-environment node

import { EventEmitter } from 'node:events'
import type { Page } from 'puppeteer-core'
import { describe, expect, test, vi } from 'vitest'
import {
  blockedReason, feedToNote, imageToken, xiaohongshu, xiaohongshuCandidates, xiaohongshuDetail,
  XHS_LOGIN_REQUIRED, XHS_UNAVAILABLE,
} from '../src/main/platforms/xiaohongshu'

const NOTE_ID = '6720a3f0000000001b0123ab'
const CDN = 'http://sns-webpic-qc.xhscdn.com/202611041200/0123456789abcdef'
const image = (name: string, extra: Record<string, unknown> = {}) => ({
  urlDefault: `${CDN}/1040g00831${name}!nd_dft_wlteh_webp_3`,
  urlPre: `${CDN}/1040g00831${name}!nd_prv_wlteh_webp_3`,
  ...extra,
})
const stream = (url: string) => ({
  h264: [
    { masterUrl: `${url}-low.mp4`, avgBitrate: 500, backupUrls: [`${url}-low-backup.mp4`] },
    { masterUrl: `${url}-high.mp4`, avgBitrate: 2000, backupUrls: [] },
  ],
  h265: [{ masterUrl: `${url}-hevc.mp4`, avgBitrate: 1500 }],
})

function fakePage(url: string, note: Record<string, unknown> | null) {
  return Object.assign(new EventEmitter(), {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => url),
    evaluate: vi.fn(async () => note),
  }) as unknown as Page
}

describe('xiaohongshu candidates', () => {
  test('reads the image token from CDN URLs', () => {
    expect(imageToken(image('abc').urlDefault)).toBe('1040g00831abc')
    expect(imageToken('https://example.com/a.jpg')).toBeNull()
  })

  test('prefers original images and falls back to the listed URL', () => {
    const [candidate] = xiaohongshuCandidates({ type: 'normal', imageList: [image('abc')] })
    expect(candidate.kind).toBe('image')
    expect(candidate.sequence).toBe(1)
    expect(candidate.urls[0]).toBe('https://sns-img-bd.xhscdn.com/1040g00831abc')
    expect(candidate.urls).toContain(`${CDN.replace('http://', 'https://')}/1040g00831abc!nd_dft_wlteh_webp_3`)
  })

  test('downloads live photos as an image and a video sharing one sequence', () => {
    const candidates = xiaohongshuCandidates({
      type: 'normal',
      imageList: [image('one'), image('two', { livePhoto: true, stream: stream('https://video.test/live') })],
    })
    expect(candidates.map((item) => [item.kind, item.sequence])).toEqual([['image', 1], ['image', 2], ['video', 2]])
    expect(candidates[2].urls[0]).toBe('https://video.test/live-high.mp4')
  })

  test('orders video streams by codec compatibility and bitrate', () => {
    const [candidate] = xiaohongshuCandidates({
      type: 'video',
      video: { consumer: { originVideoKey: 'pre_post/abc' }, media: { stream: stream('https://video.test/v') } },
    })
    expect(candidate.urls).toEqual([
      'https://sns-video-bd.xhscdn.com/pre_post/abc',
      'https://video.test/v-high.mp4',
      'https://video.test/v-low.mp4',
      'https://video.test/v-low-backup.mp4',
      'https://video.test/v-hevc.mp4',
    ])
  })

  test('maps note metadata and falls back to the description for the title', () => {
    const detail = xiaohongshuDetail({
      noteId: NOTE_ID, type: 'normal', title: '', desc: '  一段描述  ', time: 1_762_225_200_000,
      user: { nickname: '作者' }, imageList: [image('abc')],
    }, null)
    expect(detail).toMatchObject({ id: NOTE_ID, title: '一段描述', author: '作者', createdAt: '2025-11-04T03:00:00.000Z' })
  })

  test('maps feed API cards to the page state shape', () => {
    const note = feedToNote({
      note_id: NOTE_ID, type: 'normal', title: 't',
      image_list: [{
        url_default: image('abc').urlDefault, live_photo: true,
        stream: { h264: [{ master_url: 'https://video.test/live.mp4' }] },
      }],
    })
    expect(xiaohongshuCandidates(note).map((item) => item.kind)).toEqual(['image', 'video'])
  })
})

describe('xiaohongshu page state', () => {
  test('detects login and missing-note pages', () => {
    expect(blockedReason('https://www.xiaohongshu.com/website-login/captcha?redirectPath=x')).toBe(XHS_LOGIN_REQUIRED)
    expect(blockedReason('https://www.xiaohongshu.com/404?source=note')).toBe(XHS_UNAVAILABLE)
    expect(blockedReason(`https://www.xiaohongshu.com/explore/${NOTE_ID}`)).toBeNull()
  })

  test('captures the note from the initial state', async () => {
    const page = fakePage(`https://www.xiaohongshu.com/explore/${NOTE_ID}`,
      { noteId: NOTE_ID, type: 'normal', title: '标题', imageList: [image('abc')] })
    const detail = await xiaohongshu.capture(page, `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=t`,
      new AbortController().signal)
    expect(detail.title).toBe('标题')
    expect(detail.candidates).toHaveLength(1)
  })

  test('fails fast when redirected to the login page', async () => {
    const page = fakePage('https://www.xiaohongshu.com/website-login/error', null)
    await expect(xiaohongshu.capture(page, `https://www.xiaohongshu.com/explore/${NOTE_ID}`, new AbortController().signal))
      .rejects.toThrow(XHS_LOGIN_REQUIRED)
  })
})
