import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MediaStore } from '../src/media.js';
import type { Api } from '../src/types.js';

afterEach(() => vi.unstubAllGlobals());
describe('bounded video preview', () => {
  it.skipIf(!existsSync('/usr/bin/ffmpeg') || !existsSync('/usr/bin/ffprobe'))('actually decodes four local video frames, hashes and stores the media with no network', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onebot-video-')), qq = join(root, 'qq'), media = join(root, 'media'); mkdirSync(qq);
    try {
      execFileSync('/usr/bin/ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=160x90:rate=8', '-threads', '1', '-c:v', 'mpeg4', join(qq, 'sample.mp4')]);
      const api = vi.fn(async () => ({ file: '/app/.config/QQ/sample.mp4' })), fetch = vi.fn(async () => { throw Error('network must not be used'); }); vi.stubGlobal('fetch', fetch);
      const result = await new MediaStore(media, qq, api as Api).video({ type: 'video', data: { file: 'a'.repeat(32) } });
      expect(result.duration).toBeCloseTo(2); expect(result.frames).toHaveLength(4);
      expect(new Set(result.frames.map(f => f.path)).size).toBe(4);
      expect(result.frames.map(f => f.at)).toEqual([0.25, 0.75, 1.25, 1.75]);
      for (const frame of result.frames) { expect(readFileSync(frame.path).subarray(0, 3)).toEqual(Buffer.from([255, 216, 255])); }
      expect(fetch).not.toHaveBeenCalled();
      const bytes=readFileSync(join(qq,'sample.mp4'));let offset=0;
      vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({pull(controller){
        if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.subarray(offset,offset+517));offset+=517;
      }}))));
      const streamed=await new MediaStore(join(root,'streamed'),qq,api as Api).video({type:'video',data:{url:'https://multimedia.nt.qq.com.cn/fixture'}});
      expect(readFileSync(streamed.path)).toEqual(bytes);expect(streamed.frames).toHaveLength(4);
      const noFetch=vi.fn(async()=>{throw Error('cached media must not be downloaded again');});vi.stubGlobal('fetch',noFetch);
      const again=await new MediaStore(join(root,'streamed'),qq,api as Api).video({type:'video',data:{url:'https://multimedia.nt.qq.com.cn/fixture'}});
      expect(again.path).toBe(streamed.path);expect(again.frames).toHaveLength(4);expect(noFetch).not.toHaveBeenCalled();
      const named=await new MediaStore(join(root,'named'),qq,api as Api).video({type:'video',data:{file:'a'.repeat(32)+'.mp4'}});
      expect(named.frames).toHaveLength(4);
      const scopedStore=new MediaStore(join(root,'scoped'),qq,api as Api), original={type:'video',data:{file:'a'.repeat(32)+'.mp4'}};
      await scopedStore.video(original,'group-a');const callsBefore=api.mock.calls.length;
      await scopedStore.video({...original,data:{...original.data,url:'https://qq.com/refreshed-signature'}},'group-a');
      expect(api.mock.calls.length).toBe(callsBefore);expect(noFetch).not.toHaveBeenCalled();
      await expect(scopedStore.video({...original,data:{...original.data,url:'https://qq.com/refreshed-signature'}},'group-b')).rejects.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects oversized files and unsafe paths, URLs and redirects before interpreting media', async () => {
    const root = mkdtempSync(join(tmpdir(), 'onebot-video-deny-')), qq = join(root, 'qq'); mkdirSync(qq);
    try {
      const api = vi.fn(async () => ({})), store = new MediaStore(join(root, 'media'), qq, api as Api);
      await expect(store.video({ type: 'video', data: { file: '/etc/passwd' } })).rejects.toThrow('untrusted_video_url'); expect(api).not.toHaveBeenCalled();
      await expect(store.video({ type: 'video', data: { url: 'http://127.0.0.1/private' } })).rejects.toThrow('untrusted_video_url');
      await expect(store.video({ type: 'video', data: { url: 'https://qq.com/v', file_size: 129 * 1024 * 1024 } })).rejects.toThrow('video_too_large');
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })));
      await expect(store.video({ type: 'video', data: { url: 'https://qq.com/v' } })).rejects.toThrow('untrusted_video_url');
      writeFileSync(join(root, 'private.mp4'), 'private'); symlinkSync(join(root, 'private.mp4'), join(qq, 'link.mp4'));
      const unsafe = new MediaStore(join(root, 'media'), qq, (async () => ({ file: '/app/.config/QQ/link.mp4' })) as Api);
      await expect(unsafe.video({ type: 'video', data: { file: 'a'.repeat(32) } })).rejects.toThrow('unsafe_video_path');
      vi.stubGlobal('fetch', vi.fn(async () => new Response('not-a-video')));
      await expect(store.video({ type: 'video', data: { url: 'https://qq.com/not-video' } })).rejects.toThrow('unsupported_video');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
