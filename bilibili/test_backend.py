import asyncio
import json
import os
import socket
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend import Backend, ReadError, PublicResolver, allowed_url, caption_page, credential, target
from login import save


class BoundaryTests(unittest.IsolatedAsyncioTestCase):
    def test_targets_preserve_parts_and_reject_credentials_hosts_and_invalid_parts(self):
        self.assertEqual(target('https://www.bilibili.com/video/BV1xx411c7mD?p=2&share=qq'), ('BV1xx411c7mD', 2))
        self.assertEqual(target('av123'), ('av123', 1))
        for value in ('file:///etc/passwd', 'https://bilibili.com.evil/video/BV1xx411c7mD', 'https://user:pass@www.bilibili.com/video/BV1xx411c7mD',
                      'https://www.bilibili.com/video/BV1xx411c7mD?p=0', 'https://www.bilibili.com/video/BV1xx411c7mD?p=', 'https://www.bilibili.com/video/BV1xx411c7mD?p=1&p=2', 'BV1xx411c7mD/extra'):
            with self.subTest(value=value), self.assertRaises((ReadError, ValueError)):
                target(value)

    async def test_dns_filter_checks_actual_connector_addresses(self):
        resolver = PublicResolver()
        loop = asyncio.get_running_loop()
        with patch.object(loop, 'getaddrinfo', AsyncMock(return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 443))])):
            with self.assertRaisesRegex(ReadError, 'unsafe_address'):
                await resolver.resolve('subtitle.hdslb.com', 443)
        for url in ('https://localhost/sub', 'https://hdslb.com.evil/sub', 'https://user:secret@i.hdslb.com/sub', 'http://i.hdslb.com/sub'):
            with self.assertRaises(ReadError):
                allowed_url(url, 'subtitle')

    def test_timestamped_caption_pagination_has_forward_progress(self):
        body = [{'from': n, 'to': n+1, 'content': 'x'*40} for n in range(200)]
        first = caption_page(body, 0, 500)
        self.assertTrue(first['truncated'])
        self.assertEqual(first['next_start'], 12)
        self.assertEqual(caption_page(body, first['next_start'], 500)['lines'][0]['from'], 12)
        self.assertEqual(caption_page([{'from': 0, 'to': 1, 'content': 'x'*1200}], 0, 500)['next_start'], None)
        for value in (-1, True, 100001, 201):
            with self.assertRaises(ReadError):
                caption_page(body, value)

    def test_credentials_are_atomic_private_and_never_returned(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'credential.json'
            save(path, {'sessdata': 'PRIVATE', 'bili_jct': 'private'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(credential(path).sessdata, 'PRIVATE')
            os.chmod(path, 0o644)
            with self.assertRaisesRegex(ReadError, 'credential_permissions'):
                credential(path)

    async def test_part_selection_caption_coverage_and_safe_failures(self):
        fake = AsyncMock()
        fake.get_info.return_value = {'aid': 1, 'bvid': 'BV1xx411c7mD', 'pages': [{'cid': 11}, {'cid': 22, 'part': 'second'}]}
        fake.get_subtitle.return_value = {'subtitles': [{'lan': 'ai-zh', 'subtitle_url': '//i.hdslb.com/a'}, {'lan': 'zh-CN', 'subtitle_url': '//i.hdslb.com/b'}]}
        with patch('backend.video.Video', return_value=fake), patch('backend.fetch', AsyncMock(return_value={'body': [{'from': 3, 'to': 4, 'content': '事实'}]})) as fetch:
            result = await Backend().call('bili_subtitle', {'target': 'https://www.bilibili.com/video/BV1xx411c7mD?p=2'})
            self.assertTrue(result['ok'])
            self.assertEqual(result['result']['cid'], 22)
            fake.get_subtitle.assert_awaited_once_with(cid=22)
            fetch.assert_awaited_once_with('https://i.hdslb.com/b', 'subtitle')
            self.assertEqual(result['result']['coverage'], 'subtitle_only_not_visual_or_full_audio')
            fake.get_info.side_effect = RuntimeError('COOKIE_PRIVATE')
            result = await Backend().call('bili_video_info', {'target': 'BV1xx411c7mD'})
            self.assertNotIn('PRIVATE', json.dumps(result))
            self.assertEqual(result['error'], 'bilibili_read_failed')

    async def test_no_subtitle_is_not_a_successful_video_read(self):
        fake = AsyncMock()
        fake.get_info.return_value = {'aid': 1, 'bvid': 'BV1xx411c7mD', 'pages': [{'cid': 11}]}
        fake.get_subtitle.return_value = {'subtitles': []}
        with patch('backend.video.Video', return_value=fake):
            result = await Backend().call('bili_subtitle', {'target': 'BV1xx411c7mD'})
            self.assertEqual(result['result']['coverage'], 'no_subtitle')
            self.assertEqual(result['result']['lines'], [])


if __name__ == '__main__':
    unittest.main()
