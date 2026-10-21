"""Start existing services without changing accounts, secrets, images or schema."""
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request
import urllib.parse

WEBUI = 'http://127.0.0.1:6099/webui/'
UNITS = {'adapter': 'napcat-onebot.service', 'memory': 'napcat-memory.service'}


class LaunchError(Exception):
    pass


def fresh_health(health, entered, now=None):
    """A previous process's ready file must never masquerade as this startup."""
    try:
        now = time.time() if now is None else now
        start = datetime.fromisoformat(health['startedAt'].replace('Z', '+00:00')).timestamp()
        updated = datetime.fromisoformat(health['updatedAt'].replace('Z', '+00:00')).timestamp()
        return start >= entered - 2 and -2 <= now - updated <= 75
    except (KeyError, TypeError, ValueError):
        return False


class Runtime:
    def __init__(self, root=None, progress=print):
        self.root = Path(root or Path(__file__).resolve().parents[1])
        self.progress = progress
        self.env = dict(os.environ)
        runtime = self.env.setdefault('XDG_RUNTIME_DIR', '/run/user/' + str(os.getuid()))
        self.env.setdefault('DBUS_SESSION_BUS_ADDRESS', 'unix:path=' + runtime + '/bus')
        self.env['LC_ALL'] = 'C.UTF-8'
        self._credential = None
        self._auth_after = 0
        self._auth_state = 'pending'
        self._http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def run(self, args, timeout=30):
        # Never echo command outputs: docker/login failures may contain secrets.
        try:
            return subprocess.run([str(a) for a in args], cwd=self.root, env=self.env,
                                  capture_output=True, text=True, errors='replace', timeout=timeout)
        except (OSError, subprocess.TimeoutExpired):
            return subprocess.CompletedProcess(args, 124, '', '')

    def audit(self, action, ok):
        folder = self.root / 'data/adapter'
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = folder / 'launcher.jsonl'
        if path.exists() and path.stat().st_size > 1024 * 1024:
            os.replace(path, path.with_suffix('.previous.jsonl'))
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(json.dumps({'at': datetime.now(timezone.utc).isoformat(),
                                     'action': action, 'ok': ok}) + '\n')

    def action(self, title, args, timeout=90):
        result = self.run(args, timeout)
        self.audit(title, result.returncode == 0)
        if result.returncode:
            raise LaunchError(title + '未完成，请检查对应服务。凭据和原始日志未输出。')

    @contextmanager
    def exclusive(self):
        folder = self.root / 'data/adapter'
        folder.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(folder / 'launcher.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise LaunchError('另一个启动窗口正在操作服务，请稍后刷新状态。') from None
            yield

    def unit(self, key):
        result = self.run(['systemctl', '--user', 'show', UNITS[key],
                           '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState',
                           '-p', 'MainPID', '-p', 'ActiveEnterTimestampMonotonic'], 5)
        data = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        try:
            entered = time.time() - time.monotonic() + int(data.get('ActiveEnterTimestampMonotonic', 0)) / 1e6
        except ValueError:
            entered = 0
        return {'loaded': data.get('LoadState') == 'loaded',
                'active': data.get('ActiveState') == 'active',
                'state': data.get('SubState', 'unavailable'), 'entered': entered}

    def read_json(self, path):
        try:
            return json.loads((self.root / path).read_text())
        except (OSError, ValueError):
            return {}

    def postgres(self):
        result = self.run(['docker', 'inspect', '--format',
                           '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}',
                           'napcat-life-postgres-1'], 5)
        return result.returncode == 0 and result.stdout.strip() == 'running|healthy'

    def request_json(self, url, token=None, data=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        request = urllib.request.Request(url, headers=headers,
                                         data=json.dumps(data).encode() if data is not None else None)
        with self._http.open(request, timeout=3) as response:
            return json.load(response)

    def channel(self):
        base = 'http://127.0.0.1:6099/api'
        reachable = self._auth_state not in ('pending', 'unreachable')
        try:
            if not self._credential and time.monotonic() >= self._auth_after:
                # WebUI applies login rate limits. Authenticate once, reuse the
                # credential, and back off on failure instead of logging in on every refresh.
                self._auth_after = time.monotonic() + 65
                token = self.read_json('data/config/webui.json')['token']
                response = self.request_json(base + '/auth/login', data={'hash': hashlib.sha256((token + '.napcat').encode()).hexdigest()})
                reachable = True
                self._credential = (response.get('data') or {}).get('Credential')
                self._auth_state = 'passed' if self._credential else 'rate_limited' if response.get('message') == 'login rate limit' else 'failed'
            if self._credential:
                response = self.request_json(base + '/QQLogin/CheckLoginStatus', self._credential, {})
                reachable = True
                if response.get('code') == 0 and isinstance(response.get('data'), dict):
                    data = response['data']
                    return {'webui': 'ready', 'authentication': 'passed', 'qq_logged_in': bool(data.get('isLogin')),
                            'login_phase': data.get('loginPhase'), 'core_ready': bool(data.get('coreReady'))}
                self._credential = None
                self._auth_state = 'failed'
                self._auth_after = time.monotonic() + 65
        except (OSError, ValueError, KeyError, TypeError):
            self._credential = None
            self._auth_state = 'unreachable'
        # A management-page authentication issue is separate from QQ online.
        # Probe authenticated OneBot and verify the configured account before
        # reporting online; never use an old adapter health file as proof.
        result = {'webui': 'reachable' if reachable else 'not_ready', 'authentication': self._auth_state,
                  'qq_logged_in': False, 'core_ready': False, 'login_phase': 'unknown'}
        try:
            policy = self.read_json('data/config/adapter.json')
            endpoint = urllib.parse.urlparse(policy['httpUrl'])
            if endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', 'localhost', '::1') or endpoint.username or endpoint.password or endpoint.query:
                raise ValueError('unsafe_endpoint')
            config = json.loads(Path(policy['onebotConfigFile']).read_text())
            token = next(s['token'] for s in config['network']['httpServers'] if s.get('enable'))
            status = self.request_json(policy['httpUrl'].rstrip('/') + '/get_status', token, {})
            if status.get('retcode') == 0 and (status.get('data') or {}).get('online') is True:
                account = self.request_json(policy['httpUrl'].rstrip('/') + '/get_login_info', token, {})
                if account.get('retcode') == 0 and str((account.get('data') or {}).get('user_id')) == str(policy['expectedSelfId']):
                    result.update(qq_logged_in=True, core_ready=True, login_phase='ready')
                else:
                    result['login_phase'] = 'account_mismatch'
        except (OSError, ValueError, KeyError, TypeError, StopIteration):
            pass
        return result

    def status(self):
        channel = self.channel()
        adapter, memory = self.unit('adapter'), self.unit('memory')
        ah = self.read_json('data/adapter/health.json')
        mh = self.read_json('data/adapter/consolidation-health.json')
        adapter['ready'] = bool(adapter['active'] and fresh_health(ah, adapter['entered'])
                                and ah.get('connected') and ah.get('qqOnline') and ah.get('database'))
        memory['worker_state'] = mh.get('state', 'starting') if memory['active'] and fresh_health(mh, memory['entered']) else 'starting' if memory['active'] else 'stopped'
        # Only these selected fields leave the controller; no raw health/chat data.
        return {'postgres_ready': self.postgres(), 'channel': channel, 'adapter': adapter,
                'memory': memory, 'ready': bool(channel.get('qq_logged_in') and channel.get('core_ready') and adapter['ready']),
                'webui_url': WEBUI}

    def start(self, restart_qq=False):
        with self.exclusive():
            for command in ('docker', 'systemctl'):
                if not shutil.which(command, path=self.env.get('PATH')):
                    raise LaunchError('缺少命令：' + command)
            for key in UNITS:
                if not self.unit(key)['loaded']:
                    raise LaunchError('用户服务未安装：' + UNITS[key])
            self.progress('[1/5] 检查 Docker…')
            if self.run(['docker', 'info', '--format', '{{.ServerVersion}}'], 10).returncode:
                self.action('启动 Docker', ['systemctl', 'start', 'docker.service'])
                if self.run(['docker', 'info', '--format', '{{.ServerVersion}}'], 10).returncode:
                    raise LaunchError('Docker 尚不可用，请检查服务和当前用户的 Docker 访问权限。')
            self.progress('[2/5] 启动记忆数据库…')
            self.action('启动数据库', [self.root / 'scripts/life-db', 'start'])
            deadline = time.monotonic() + 60
            while not self.postgres():
                if time.monotonic() >= deadline:
                    raise LaunchError('数据库未就绪，暂不启动后续服务。')
                time.sleep(1)
            self.progress('[3/5] ' + ('重启 QQ，测试缓存／密码自动登录…' if restart_qq else '启动 NapCat…'))
            if restart_qq:
                self.action('停止适配器', [self.root / 'scripts/onebot-adapter', 'stop'])
            try:
                self.action('重启 NapCat' if restart_qq else '启动 NapCat',
                            [self.root / 'scripts/napcat', 'restart' if restart_qq else 'start'])
            except (LaunchError, KeyboardInterrupt):
                if restart_qq:
                    result = self.run([self.root / 'scripts/onebot-adapter', 'start'])
                    self.audit('恢复适配器等待连接', result.returncode == 0)
                raise
            self.progress('[4/5] 启动 QQ 适配器…')
            self.action('启动适配器', [self.root / 'scripts/onebot-adapter', 'start'])
            self.progress('[5/5] 启动后台记忆整理…')
            self.action('启动记忆整理', [self.root / 'scripts/memory-worker', 'start'])

    def wait_webui(self, timeout=60):
        deadline = time.monotonic() + timeout
        while True:
            state = self.channel()
            if state.get('webui') in ('ready', 'reachable'):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(2)

    def open_webui(self):
        opener = shutil.which('xdg-open', path=self.env.get('PATH'))
        if not opener or not (self.env.get('DISPLAY') or self.env.get('WAYLAND_DISPLAY')):
            self.progress('请在浏览器打开：' + WEBUI)
            return False
        result = self.run([opener, WEBUI], 15)
        if result.returncode:
            self.progress('浏览器未自动打开，请访问：' + WEBUI)
        return result.returncode == 0
