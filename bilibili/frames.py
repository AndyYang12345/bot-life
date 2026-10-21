"""Download one small public video stream and sample local frames. No audio analysis."""
import asyncio
import base64
import json
import os
import shutil
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

import aiohttp


def stream_url(value):
    u = urlsplit(value)
    if u.scheme != 'https' or u.username or u.password or u.port not in (None, 443):
        raise ValueError('unsafe_video_url')
    host = u.hostname or ''
    if not any(host == root or host.endswith('.' + root) for root in ('bilivideo.com', 'bilivideo.cn', 'hdslb.com')):
        raise ValueError('unsafe_video_url')
    return value


def select_stream(data):
    streams = [x for x in data.get('dash', {}).get('video', []) if str(x.get('codecs', '')).startswith('avc') and int(x.get('id', 999)) <= 32]
    if not streams:
        raise ValueError('small_avc_stream_unavailable')
    selected = min(streams, key=lambda x: (int(x['id']), int(x.get('bandwidth', 0))))
    return stream_url(selected.get('baseUrl') or selected.get('base_url') or '')


async def run(*args, timeout=10):
    child = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    try:
        output, _ = await asyncio.wait_for(child.communicate(), timeout)
        if child.returncode or len(output) > 64000:
            raise ValueError('video_decode_failed')
        return output
    finally:
        if child.returncode is None:
            child.kill()
            await child.wait()


OPTIONS = ('-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm', '-threads', '1')


async def local_frames(source, directory):
    data = json.loads(await run('/usr/bin/ffprobe', '-v', 'error', *OPTIONS, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', str(source)))
    duration = float(data.get('format', {}).get('duration', 0))
    stream = next((x for x in data.get('streams', []) if x.get('codec_type') == 'video'), {})
    if not 0 < duration <= 600 or not 0 < stream.get('width', 0) <= 4096 or not 0 < stream.get('height', 0) <= 4096:
        raise ValueError('video_preview_limits')
    frames = []
    for index in range(6):
        at = round(min(duration * (index + 0.5) / 6, max(0, duration - 0.05)), 2)
        path = directory / f'{index}.jpg'
        await run('/usr/bin/ffmpeg', '-nostdin', '-v', 'error', *OPTIONS, '-ss', str(at), '-i', str(source), '-map', '0:v:0', '-an', '-sn', '-dn',
                  '-frames:v', '1', '-vf', 'scale=768:768:force_original_aspect_ratio=decrease', '-threads', '1', '-q:v', '6', '-y', str(path))
        if not 0 < path.stat().st_size <= 200000:
            raise ValueError('frame_too_large')
        frames.append({'at': at, 'jpeg_base64': base64.b64encode(path.read_bytes()).decode()})
    return {'coverage': 'six_sampled_frames_not_full_video_or_audio', 'duration_seconds': duration, 'frames': frames}


async def preview(data, cache, resolver, user_agent):
    url = select_stream(data)
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Remove media left by a previously killed MCP process; never grow an unbounded download cache.
    for previous in cache.glob('.preview-*'):
        try:
            pid = int(previous.name.split('-')[1])
            os.kill(pid, 0)
        except ProcessLookupError:
            if previous.is_dir() and not previous.is_symlink():
                shutil.rmtree(previous)
        except (ValueError, PermissionError):
            pass
    with tempfile.TemporaryDirectory(prefix=f'.preview-{os.getpid()}-', dir=cache) as temporary:
        directory = Path(temporary)
        source = directory / 'stream.mp4'
        size = 0
        async with aiohttp.ClientSession(trust_env=False, connector=aiohttp.TCPConnector(resolver=resolver, use_dns_cache=False),
                                        timeout=aiohttp.ClientTimeout(total=45), headers={'User-Agent': user_agent, 'Referer': 'https://www.bilibili.com/'}) as session:
            async with session.get(url, allow_redirects=False) as response:
                if response.status != 200 or int(response.headers.get('Content-Length', '0')) > 128 * 1024 * 1024:
                    raise ValueError('video_download_unavailable')
                with source.open('xb') as output:
                    os.chmod(source, 0o600)
                    async for chunk in response.content.iter_chunked(65536):
                        size += len(chunk)
                        if size > 128 * 1024 * 1024:
                            raise ValueError('video_too_large')
                        output.write(chunk)
        return await local_frames(source, directory)
