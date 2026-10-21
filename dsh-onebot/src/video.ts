import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const run = promisify(execFile);
export interface VideoPreview { path: string; duration: number; frames: { path: string; at: number }[] }
const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm,avi', '-threads', '1'];

/** Local video only; no shell, playlists, network protocols or audio transcription. */
export async function previewVideo(path: string, root: string, saveImage: (bytes: Buffer) => Promise<string>): Promise<VideoPreview> {
  const temp = await mkdtemp(join(root, '.video-'));
  try {
    const probe = await run('/usr/bin/ffprobe', ['-v', 'error', ...inputOptions, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', path],
      { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 64000 });
    const info = JSON.parse(probe.stdout), duration = Number(info.format?.duration);
    const stream = info.streams?.find((s: any) => s.codec_type === 'video');
    if (!Number.isFinite(duration) || duration <= 0 || duration > 300 || !stream || stream.width > 4096 || stream.height > 4096) throw Error('unsupported_video_limits');
    const frames: VideoPreview['frames'] = [];
    for (let i = 0; i < 4; i++) {
      const at = Math.min(duration * (i + 0.5) / 4, Math.max(0, duration - 0.05)), output = join(temp, i + '.jpg');
      await run('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', ...inputOptions, '-ss', String(at), '-i', path, '-map', '0:v:0', '-an', '-sn', '-dn',
        '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-threads', '1', '-q:v', '4', '-y', output],
      { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 64000 });
      frames.push({ at: Math.round(at * 100) / 100, path: await saveImage(await readFile(output)) });
    }
    return { path, duration, frames };
  } catch { throw Error('video_preview_unavailable'); }
  finally { await rm(temp, { recursive: true, force: true }); }
}
