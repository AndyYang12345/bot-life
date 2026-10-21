import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import type { Api, Segment } from './types.js';
import { previewVideo } from './video.js';
import type { VideoPreview } from './video.js';

export function trustedImageUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
      && (!u.port || ['80', '443'].includes(u.port))
      && ['qpic.cn', 'qq.com', 'qq.com.cn', 'gtimg.com'].some(root => u.hostname === root || u.hostname.endsWith('.' + root));
  } catch { return false; }
}
function extension(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 3).toString() === 'GIF') return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('unsupported_image');
}
export class MediaStore {
  constructor(private root: string, private qqRoot: string, private api: Api, private maxBytes = 20 * 1024 * 1024) {}
  async imageBytes(bytes:Buffer):Promise<string>{
    if(bytes.length>this.maxBytes)throw Error('image_too_large');
    return this.save(bytes,extension(bytes));
  }
  async image(segment: Segment): Promise<string> {
    let url = typeof segment.data.url === 'string' ? segment.data.url : '';
    let file = '';
    if (segment.data.file) {
      try {
        const info = await this.api<{ url?: string; file?: string }>('get_image', { file: segment.data.file });
        url = info.url || url;
        file = info.file || '';
      } catch { /* A live signed event URL can still be used. */ }
    }
    let bytes: Buffer | undefined;
    // The only container path mapping is the existing isolated QQ volume.
    if (file.startsWith('/app/.config/QQ/')) {
      const source = join(this.qqRoot, file.slice('/app/.config/QQ/'.length));
      const [realRoot, real] = await Promise.all([realpath(this.qqRoot), realpath(source)]);
      const rel = relative(realRoot, real);
      if (rel.startsWith('..') || isAbsolute(rel) || !rel) throw new Error('unsafe_media_path');
      if ((await stat(real)).size > this.maxBytes) throw new Error('image_too_large');
      bytes = await readFile(real);
    } else {
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (!trustedImageUrl(url)) throw new Error('untrusted_image_url');
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error('invalid_redirect');
          url = new URL(location, url).href;
          await response.body?.cancel();
          continue;
        }
        if (!response.ok || !response.body) throw new Error('image_download_failed');
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > this.maxBytes) { await response.body.cancel(); throw new Error('image_too_large'); }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > this.maxBytes) throw new Error('image_too_large');
          chunks.push(Buffer.from(chunk));
        }
        bytes = Buffer.concat(chunks);
        break;
      }
    }
    if (!bytes) throw new Error('image_unavailable');
    return this.save(bytes, extension(bytes));
  }
  private async save(bytes: Buffer, ext: string): Promise<string> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, hash + '.' + ext);
    const temp = path + '.' + randomUUID() + '.tmp';
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    const directory = await open(this.root, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return path;
  }
  async video(segment: Segment, conversation?: string): Promise<VideoPreview> {
    const maxBytes = 128 * 1024 * 1024;
    if (Number(segment.data.file_size ?? segment.data.size ?? 0) > maxBytes) throw Error('video_too_large');
    let url = typeof segment.data.url === 'string' ? segment.data.url : '';
    let file = '';
    const id = segment.data.file_id ?? segment.data.file;
    const opaque = typeof id === 'string' && /^(?:[a-fA-F0-9]{32}(?:\.mp4)?|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(id);
    // Conversation is supplied only by normalize's trusted outer event. A
    // stable opaque ID permits refreshed signed URLs without cross-group hits.
    const cacheKey = createHash('sha256').update(JSON.stringify(conversation && opaque
      ? [conversation,id,segment.data.file_size,segment.data.size]
      : [segment.data.url,segment.data.file_id,segment.data.file,segment.data.file_size,segment.data.size])).digest('hex');
    const cacheFile = join(this.root, '.video-cache-' + cacheKey + '.json');
    try {
      const cached = JSON.parse(await readFile(cacheFile,'utf8'));
      if (Date.now() - cached.at >= 0 && Date.now() - cached.at < 86400000 && typeof cached.file === 'string' && /^[a-f0-9]{64}\.(mp4|webm|avi)$/.test(cached.file)) {
        const [realRoot, real] = await Promise.all([realpath(this.root),realpath(join(this.root,cached.file))]);
        const rel = relative(realRoot,real);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel) && (await stat(real)).size<=maxBytes) {
          return await previewVideo(real,this.root,data=>this.save(data,extension(data)));
        }
      }
    } catch { /* A missing/stale/damaged cache never authorizes arbitrary files. */ }
    // get_file accepts paths too: only pass an opaque NapCat file ID.
    if (!trustedImageUrl(url) && opaque) {
      const info = await this.api<{ url?: string; file?: string; file_size?: string }>('get_file', { file_id: id });
      if (Number(info.file_size ?? 0) > maxBytes) throw Error('video_too_large');
      url = info.url || ''; file = info.file || '';
    }
    let source: AsyncIterable<Uint8Array> | undefined;
    if (file.startsWith('/app/.config/QQ/')) {
      const [realRoot, real] = await Promise.all([realpath(this.qqRoot), realpath(join(this.qqRoot, file.slice('/app/.config/QQ/'.length)))]);
      const rel = relative(realRoot, real);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('unsafe_video_path');
      if ((await stat(real)).size > maxBytes) throw Error('video_too_large');
      source = createReadStream(real);
    } else {
      const signal = AbortSignal.timeout(60000);
      for (let i = 0; i <= 3; i++) {
        if (!trustedImageUrl(url)) throw Error('untrusted_video_url');
        const response = await fetch(url, { redirect: 'manual', signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location'); await response.body?.cancel();
          if (!location) throw Error('invalid_video_redirect');
          url = new URL(location, url).href; continue;
        }
        if (!response.ok || !response.body) throw Error('video_download_failed');
        if (Number(response.headers.get('content-length') || 0) > maxBytes) { await response.body.cancel(); throw Error('video_too_large'); }
        source = response.body; break;
      }
    }
    if (!source) throw Error('video_unavailable');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = join(this.root, '.download-' + randomUUID() + '.tmp'), hash = createHash('sha256');
    let header = Buffer.alloc(0), size = 0;
    const handle = await open(temp, 'wx', 0o600);
    let path: string;
    try {
      try {
        for await (const chunk of source) {
          size += chunk.byteLength; if (size > maxBytes) throw Error('video_too_large');
          hash.update(chunk);
          if (header.length < 16) header = Buffer.concat([header, Buffer.from(chunk.subarray(0, 16 - header.length))]);
          await handle.writeFile(chunk);
        }
        const ext = header.subarray(4, 8).toString() === 'ftyp' ? 'mp4'
          : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'webm'
          : header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'AVI ' ? 'avi' : '';
        if (!ext) throw Error('unsupported_video');
        path = join(this.root, hash.digest('hex') + '.' + ext); await handle.sync();
      } finally { await handle.close(); }
      await rename(temp, path);
      const directory = await open(this.root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temp, { force: true }); }
    const preview = await previewVideo(path, this.root, data => this.save(data, extension(data)));
    const cacheTemp = cacheFile+'.tmp-'+randomUUID();
    try {
      const cached = await open(cacheTemp,'wx',0o600);
      try { await cached.writeFile(JSON.stringify({at:Date.now(),file:basename(path)})); await cached.sync(); }
      finally { await cached.close(); }
      await rename(cacheTemp,cacheFile);
    } catch { /* Cache failure must not discard a successful video preview. */ }
    finally { await rm(cacheTemp,{force:true}).catch(()=>{}); }
    return preview;
  }
}
