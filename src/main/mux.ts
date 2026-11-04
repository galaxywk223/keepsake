import ffmpeg from '@ffmpeg-installer/ffmpeg'
import { spawn as defaultSpawn } from 'node:child_process'
import { resolveFfmpegPath } from './audio'

/** Combines a video-only and an audio-only stream (e.g. DASH segments) into one MP4 without re-encoding. */
export type Muxer = (videoPath: string, audioPath: string, outputPath: string, signal: AbortSignal) => Promise<void>

export function createFfmpegMuxer(ffmpegPath = ffmpeg.path, spawn: typeof defaultSpawn = defaultSpawn): Muxer {
  const executable = resolveFfmpegPath(ffmpegPath)
  return (videoPath, audioPath, outputPath, signal) => new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', outputPath,
    ], { windowsHide: true, signal })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().slice(0, 300) || `音视频合并失败（退出码 ${code}）`))
    })
  })
}
