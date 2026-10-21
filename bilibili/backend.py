"""Bounded public Bilibili reads. Credentials stay in this process, never in results."""
import asyncio
import ipaddress
import json
import re
import socket
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlsplit

import aiohttp
from bilibili_api import Credential, comment, search, video
from frames import preview

UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
ID = re.compile(r'(?:BV[A-Za-z0-9]{10}|av[1-9][0-9]{0,19})\Z')


class ReadError(Exception):
    pass


def clean(value, limit=500):
    return re.sub(r'[\x00-\x08\x0b-\x1f]', '', str(value or ''))[:limit]


def target(value):
    if not isinstance(value, str) or len(value) > 2048:
        raise ReadError('invalid_target')
    if ID.fullmatch(value):
        return value, 1
    u = urlsplit(value)
    if u.scheme not in ('https', 'http') or u.username or u.password or u.port not in (None, 80, 443):
        raise ReadError('invalid_target')
    if u.hostname not in ('www.bilibili.com', 'bilibili.com', 'm.bilibili.com'):
        raise ReadError('invalid_target')
    match = re.fullmatch(r'/video/(BV[A-Za-z0-9]{10}|av[1-9][0-9]{0,19})/?', u.path)
    values = parse_qs(u.query, keep_blank_values=True).get('p', ['1'])
    if not match or len(values) != 1 or not re.fullmatch(r'[1-9][0-9]?', values[0]):
        raise ReadError('invalid_target')
    return match[1], int(values[0])


class PublicResolver(aiohttp.abc.AbstractResolver):
    """Validate the addresses actually handed to the connector (no DNS check/use gap)."""
    async def resolve(self, host, port=0, family=socket.AF_INET):
        records = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM, family=family)
        if not records or any(not ipaddress.ip_address(r[4][0]).is_global for r in records):
            raise ReadError('unsafe_address')
        return [{'hostname': host, 'host': r[4][0], 'port': port, 'family': r[0], 'proto': r[2], 'flags': 0} for r in records]

    async def close(self):
        pass


def allowed_url(url, kind):
    u = urlsplit(url)
    if u.scheme != 'https' or u.username or u.password or u.port not in (None, 443):
        raise ReadError('unsafe_url')
    host = u.hostname or ''
    if kind == 'short':
        if host != 'b23.tv' or not re.fullmatch(r'/[A-Za-z0-9]{1,64}/?', u.path):
            raise ReadError('invalid_target')
    elif not (host == 'hdslb.com' or host.endswith('.hdslb.com') or host == 'bilibili.com' or host.endswith('.bilibili.com')):
        raise ReadError('unsafe_subtitle_url')
    return url


async def fetch(url, kind):
    """No cookies or proxy inheritance for arbitrary subtitle/short-link HTTP."""
    allowed_url(url, kind)
    connector = aiohttp.TCPConnector(resolver=PublicResolver(), use_dns_cache=False)
    async with aiohttp.ClientSession(connector=connector, trust_env=False, timeout=aiohttp.ClientTimeout(total=12), headers={'User-Agent': UA}) as session:
        async with session.get(url, allow_redirects=False) as response:
            if kind == 'short':
                if response.status not in (301, 302, 303, 307, 308):
                    raise ReadError('short_link_unavailable')
                location = urljoin(url, response.headers.get('Location', ''))
                # Only one redirect, directly to an identified Bilibili video; never follow arbitrary hosts.
                target(location)
                return location
            if response.status != 200:
                raise ReadError('subtitle_unavailable')
            data = bytearray()
            async for chunk in response.content.iter_chunked(16384):
                data.extend(chunk)
                if len(data) > 2 * 1024 * 1024:
                    raise ReadError('subtitle_too_large')
            return json.loads(data)


def credential(path):
    if not path or not Path(path).exists():
        return Credential()
    p = Path(path)
    if p.stat().st_mode & 0o077:
        raise ReadError('credential_permissions')
    value = json.loads(p.read_text())
    return Credential(**{k: str(value[k]) for k in ('sessdata', 'bili_jct', 'buvid3', 'buvid4', 'dedeuserid', 'ac_time_value') if value.get(k)})


def caption_page(body, start=0, limit=8000):
    if type(start) is not int or not 0 <= start <= 100000 or type(limit) is not int or not 500 <= limit <= 10000:
        raise ReadError('invalid_caption_range')
    if start and start >= len(body):
        raise ReadError('caption_start_out_of_range')
    lines, used, index = [], 0, start
    while index < len(body) and len(lines) < 160:
        item = body[index]
        raw = clean(item.get('content'), 10001)
        text = raw[:min(1000, limit)]
        if used + len(text) > limit:
            break
        begin, end = float(item.get('from', 0)), float(item.get('to', 0))
        if not 0 <= begin <= end <= 86400:
            raise ReadError('invalid_caption')
        lines.append({'from': begin, 'to': end, 'text': text, 'text_truncated': len(text) < len(raw)})
        used += len(text)
        index += 1
    return {'lines': lines, 'start': start, 'next_start': index if index < len(body) else None,
            'total_lines': len(body), 'truncated': index < len(body) or any(x['text_truncated'] for x in lines)}


class Backend:
    def __init__(self, credentials=None):
        self.credentials = credentials

    async def identified(self, value):
        if isinstance(value, str) and value.startswith(('https://b23.tv/', 'http://b23.tv/')):
            # Canonical HTTPS only; no cookie-bearing request to a short-link service.
            value = await fetch('https://' + value.split('://', 1)[1], 'short')
        ident, part = target(value)
        v = video.Video(**({'bvid': ident} if ident.startswith('BV') else {'aid': int(ident[2:])}), credential=credential(self.credentials))
        info = await v.get_info()
        pages = info.get('pages') or await v.get_pages()
        if not 1 <= part <= len(pages):
            raise ReadError('part_not_found')
        return v, info, pages[part - 1], part

    async def call(self, name, args):
        try:
            result = await asyncio.wait_for(self.read(name, args), 110 if name == 'bili_video_preview' else 25)
            return {'ok': True, 'result': result, 'error': None}
        except ReadError as e:
            return {'ok': False, 'result': None, 'error': str(e)}
        except asyncio.TimeoutError:
            return {'ok': False, 'result': None, 'error': 'bilibili_timeout'}
        except Exception:
            # SDK exceptions can contain URLs, cookie-bearing headers and server internals.
            return {'ok': False, 'result': None, 'error': 'bilibili_read_failed'}

    async def read(self, name, args):
        if name == 'bili_search':
            keyword = args.get('keyword', '')
            if not isinstance(keyword, str) or not 1 <= len(keyword.strip()) <= 100:
                raise ReadError('invalid_keyword')
            data = await search.search_by_type(keyword.strip(), search_type=search.SearchObjectType.VIDEO, page=1, page_size=5)
            return {'source': 'bilibili_search', 'items': [{'bvid': clean(x.get('bvid'), 20), 'url': 'https://www.bilibili.com/video/' + clean(x.get('bvid'), 20),
                    'title': re.sub('<[^>]*>', '', clean(x.get('title'))), 'author': clean(x.get('author'), 80), 'description': clean(x.get('description'), 800)} for x in data.get('result', []) if ID.fullmatch(str(x.get('bvid', '')))][:5]}
        if name not in ('bili_video_info', 'bili_subtitle', 'bili_comments', 'bili_video_preview'):
            raise ReadError('unknown_tool')
        v, info, page, part = await self.identified(args.get('target'))
        base = {'source': 'bilibili', 'bvid': info['bvid'], 'url': 'https://www.bilibili.com/video/' + info['bvid'] + (f'?p={part}' if part > 1 else ''),
                'part': part, 'cid': page['cid'], 'part_title': clean(page.get('part'))}
        if name == 'bili_video_preview':
            if not 0 < float(page.get('duration', 0)) <= 600:
                raise ReadError('video_preview_max_10_minutes')
            data = await v.get_download_url(cid=page['cid'])
            cache = Path(self.credentials).parent / 'cache' if self.credentials else Path(tempfile.gettempdir()) / 'qqbot-bili-preview'
            try:
                return {**base, **await preview(data, cache, PublicResolver(), UA)}
            except ValueError:
                raise ReadError('video_preview_unavailable')
        if name == 'bili_video_info':
            return {**base, 'coverage': 'metadata_only', 'title': clean(info.get('title')), 'description': clean(info.get('desc'), 2000),
                    'author': clean(info.get('owner', {}).get('name'), 80), 'duration_seconds': page.get('duration'), 'parts': len(info.get('pages', [])),
                    'published_at': info.get('pubdate')}
        if name == 'bili_comments':
            data = await comment.get_comments(info['aid'], comment.CommentResourceType.VIDEO, page_index=1, credential=credential(self.credentials))
            return {**base, 'coverage': 'first_page_comments_not_video', 'items': [{'text': clean(x.get('content', {}).get('message'), 800)} for x in (data.get('replies') or [])[:8]]}
        data = await v.get_subtitle(cid=page['cid'])
        options = data.get('subtitles') or []
        if not options:
            return {**base, 'coverage': 'no_subtitle', 'lines': [], 'reason': 'no_subtitle_or_login_required'}
        chosen = min(options, key=lambda x: (['zh-CN', 'zh-Hans', 'zh', 'ai-zh'].index(x.get('lan')) if x.get('lan') in ['zh-CN', 'zh-Hans', 'zh', 'ai-zh'] else 10))
        url = chosen.get('subtitle_url', '')
        if url.startswith('//'):
            url = 'https:' + url
        captions = await fetch(url, 'subtitle')
        body = captions.get('body')
        if not isinstance(body, list) or len(body) > 100000:
            raise ReadError('invalid_caption')
        return {**base, 'coverage': 'subtitle_only_not_visual_or_full_audio', 'language': clean(chosen.get('lan'), 40),
                'machine_generated': str(chosen.get('lan', '')).startswith('ai-'), **caption_page(body, args.get('start', 0), args.get('limit', 8000))}
