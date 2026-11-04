import { describe, expect, test } from 'vitest'
import { extractAwemeId, extractUrls, identifySource, isSupportedSource, normalizeSourceUrl } from '../src/main/parser'

const NOTE_ID = '6720a3f0000000001b0123ab'

describe('source parser', () => {
  test('deduplicates links and removes Chinese punctuation', () => {
    expect(extractUrls('作品 https://v.douyin.com/abc/，重复 https://v.douyin.com/abc/。')).toEqual([
      'https://v.douyin.com/abc/',
    ])
  })

  test('accepts only supported hosts and extracts work ids', () => {
    expect(isSupportedSource('https://www.douyin.com/video/123456')).toBe(true)
    expect(isSupportedSource('https://example.com/video/123456')).toBe(false)
    expect(isSupportedSource(`https://notxiaohongshu.com/explore/${NOTE_ID}`)).toBe(false)
    expect(extractAwemeId('https://www.douyin.com/video/123456')).toBe('123456')
  })

  test('identifies Xiaohongshu notes and short links', () => {
    expect(identifySource(`https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=abc`))
      .toEqual({ platform: 'xiaohongshu', id: NOTE_ID })
    expect(identifySource(`https://www.xiaohongshu.com/discovery/item/${NOTE_ID.toUpperCase()}`))
      .toEqual({ platform: 'xiaohongshu', id: NOTE_ID })
    expect(identifySource('http://xhslink.com/a/AbCdEf')).toEqual({ platform: 'xiaohongshu', id: null })
    expect(identifySource('https://www.douyin.com/video/123')).toEqual({ platform: 'douyin', id: '123' })
  })

  test('extracts Xiaohongshu links from App share text', () => {
    const text = '看看这篇笔记 http://xhslink.com/a/AbCdEf，复制本条信息，打开【小红书】App查看精彩内容！'
    expect(extractUrls(text)).toEqual(['http://xhslink.com/a/AbCdEf'])
  })

  test('canonicalizes note URLs and keeps only the access token parameters', async () => {
    const url = `https://www.xiaohongshu.com/discovery/item/${NOTE_ID}?app_platform=ios&xsec_token=TOKEN%3D&xsec_source=app_share&share_id=1`
    expect(await normalizeSourceUrl(url))
      .toBe(`https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=TOKEN%3D&xsec_source=app_share`)
  })
})
