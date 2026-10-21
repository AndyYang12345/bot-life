import asyncio
import base64
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from frames import local_frames, select_stream, stream_url


class FrameTests(unittest.IsolatedAsyncioTestCase):
    def test_only_small_avc_from_fixed_public_cdn_domains(self):
        data = {'dash': {'video': [{'id': 80, 'codecs': 'avc1', 'baseUrl': 'https://video.bilivideo.com/1080'},
                                  {'id': 16, 'codecs': 'hvc1', 'baseUrl': 'https://video.bilivideo.com/hevc'},
                                  {'id': 16, 'codecs': 'avc1', 'baseUrl': 'https://video.bilivideo.com/360'}]}}
        self.assertEqual(select_stream(data), 'https://video.bilivideo.com/360')
        for value in ('http://video.bilivideo.com/a', 'https://video.bilivideo.com.evil/a', 'https://127.0.0.1/a', 'https://u:p@video.bilivideo.com/a'):
            with self.assertRaises(ValueError):
                stream_url(value)
        with self.assertRaises(ValueError):
            select_stream({'dash': {'video': data['dash']['video'][:1]}})

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'requires ffmpeg')
    async def test_actual_local_decoder_samples_six_frames_without_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'fixture.mp4'
            subprocess.run(['/usr/bin/ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=160x90:rate=8', '-threads', '1', '-c:v', 'mpeg4', str(source)], check=True)
            result = await local_frames(source, root)
            self.assertEqual(result['coverage'], 'six_sampled_frames_not_full_video_or_audio')
            self.assertEqual([f['at'] for f in result['frames']], [0.25, 0.75, 1.25, 1.75, 2.25, 2.75])
            for frame in result['frames']:
                self.assertTrue(base64.b64decode(frame['jpeg_base64']).startswith(b'\xff\xd8\xff'))


if __name__ == '__main__':
    unittest.main()
