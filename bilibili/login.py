"""Local administrator QR login. No passwords, cookie values or QR URL in output."""
import argparse
import asyncio
import json
import os
import tempfile
from pathlib import Path

import aiohttp
import qrcode
from backend import UA, credential


def emit(state, **fields):
    print(json.dumps({'state': state, **fields}, ensure_ascii=False), flush=True)


def save(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.credential-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


async def login(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    qr = directory / 'login.png'
    try:
        async with aiohttp.ClientSession(trust_env=False, timeout=aiohttp.ClientTimeout(total=12), headers={'User-Agent': UA}) as session:
            async with session.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', allow_redirects=False) as r:
                payload = await r.json()
            if payload.get('code') != 0:
                raise RuntimeError()
            data = payload['data']
            qrcode.make(data['url']).save(qr)
            os.chmod(qr, 0o600)
            emit('waiting', qrFile=str(qr))
            previous = None
            for _ in range(85):
                await asyncio.sleep(2)
                async with session.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll', params={'qrcode_key': data['qrcode_key']}, allow_redirects=False) as r:
                    result = (await r.json())['data']
                    cookies = {k: v.value for k, v in r.cookies.items()}
                code = result.get('code')
                if code == 0:
                    mapping = {'SESSDATA': 'sessdata', 'bili_jct': 'bili_jct', 'buvid3': 'buvid3', 'DedeUserID': 'dedeuserid'}
                    value = {dest: cookies[key] for key, dest in mapping.items() if cookies.get(key)}
                    if not value.get('sessdata') or not value.get('bili_jct'):
                        raise RuntimeError()
                    if not value.get('buvid3'):
                        async with session.get('https://api.bilibili.com/x/frontend/finger/spi', allow_redirects=False) as r:
                            value['buvid3'] = (await r.json()).get('data', {}).get('b_3', '')
                    save(directory / 'credential.json', value)
                    emit('logged_in', credentialFile=str(directory / 'credential.json'))
                    return
                if code == 86038:
                    emit('expired')
                    return
                state = 'confirm_on_phone' if code == 86090 else 'waiting'
                if state != previous:
                    emit(state)
                    previous = state
            emit('expired')
    finally:
        qr.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['login', 'status'])
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.action == 'status':
            cred = credential(args.directory / 'credential.json')
            emit('credential_present' if cred.sessdata else 'login_required')
        else:
            asyncio.run(login(args.directory))
    except KeyboardInterrupt:
        emit('cancelled')
    except Exception:
        emit('login_failed')
        raise SystemExit(1)
