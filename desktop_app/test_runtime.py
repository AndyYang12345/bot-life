"""Service-control contracts; isolated directories and fake processes only."""
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

from desktop_app import cli
from desktop_app.install import install, desktop_entry, exec_arg
from desktop_app.runtime import LaunchError, Runtime, fresh_health


class RuntimeTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.r = Runtime(self.root, progress=lambda *_: None)
        self.calls = []

    def fake_run(self, args, timeout=30):
        args = [str(x) for x in args]
        self.calls.append(args)
        output = ''
        if args[:3] == ['systemctl', '--user', 'show']:
            output = 'LoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestampMonotonic=' + str(int(time.monotonic() * 1e6))
        elif args[:2] == ['docker', 'inspect']:
            output = 'running|healthy'
        return subprocess.CompletedProcess(args, 0, output, '')

    def test_start_orders_dependencies_and_never_restarts_existing_qq(self):
        with patch.object(self.r, 'run', side_effect=self.fake_run):
            self.r.start()
            self.r.start()
        actions = [x for x in self.calls if x[0].startswith(str(self.root))]
        self.assertEqual([Path(x[0]).name for x in actions[:4]], ['life-db', 'napcat', 'onebot-adapter', 'memory-worker'])
        self.assertTrue(all(x[-1] == 'start' for x in actions))
        self.assertNotIn('--force-recreate', json.dumps(self.calls))
        self.assertEqual((self.root / 'data/adapter/launcher.jsonl').stat().st_mode & 0o777, 0o600)

    def test_only_explicit_restart_stops_adapter_and_restarts_qq(self):
        with patch.object(self.r, 'run', side_effect=self.fake_run):
            self.r.start(True)
        actions = [(Path(x[0]).name, x[-1]) for x in self.calls if x[0].startswith(str(self.root))]
        self.assertEqual(actions, [('life-db', 'start'), ('onebot-adapter', 'stop'), ('napcat', 'restart'), ('onebot-adapter', 'start'), ('memory-worker', 'start')])

    def test_database_failure_prevents_starting_later_services(self):
        def fail(args, timeout=30):
            if Path(args[0]).name == 'life-db':
                self.calls.append([str(x) for x in args])
                return subprocess.CompletedProcess(args, 1, 'SECRET', 'SECRET')
            return self.fake_run(args, timeout)
        with patch.object(self.r, 'run', side_effect=fail):
            with self.assertRaises(LaunchError) as caught:
                self.r.start()
        self.assertNotIn('SECRET', str(caught.exception))
        self.assertNotIn('SECRET', (self.root / 'data/adapter/launcher.jsonl').read_text())
        self.assertFalse(any(Path(x[0]).name == 'napcat' for x in self.calls))

    def test_failed_qq_restart_restores_adapter_waiting_service(self):
        def fail(args, timeout=30):
            if Path(args[0]).name == 'napcat':
                return subprocess.CompletedProcess(args, 1, '', '')
            return self.fake_run(args, timeout)
        with patch.object(self.r, 'run', side_effect=fail):
            with self.assertRaises(LaunchError):
                self.r.start(True)
        self.assertEqual(self.calls[-1], [str(self.root / 'scripts/onebot-adapter'), 'start'])

    def test_exclusive_start_lock_is_released(self):
        with self.r.exclusive():
            with self.assertRaises(LaunchError):
                with Runtime(self.root).exclusive():
                    self.fail('concurrent launch allowed')
        with self.r.exclusive():
            pass

    def test_old_or_stale_health_never_becomes_ready(self):
        iso = lambda n: datetime.fromtimestamp(n, timezone.utc).isoformat()
        now = time.time()
        self.assertTrue(fresh_health({'startedAt': iso(now - 4), 'updatedAt': iso(now)}, now - 5, now))
        self.assertFalse(fresh_health({'startedAt': iso(now - 100), 'updatedAt': iso(now)}, now - 5, now))
        self.assertFalse(fresh_health({'startedAt': iso(now - 200), 'updatedAt': iso(now - 100)}, now - 201, now))
        self.assertFalse(fresh_health({'startedAt': iso(now - 4), 'updatedAt': iso(now + 10)}, now - 5, now))
        self.assertFalse(fresh_health({}, now, now))

    def test_waits_for_authenticated_webui_instead_of_fixed_sleep(self):
        with patch.object(self.r, 'channel', side_effect=[{'webui': 'not_ready'}, {'webui': 'ready'}]), patch('desktop_app.runtime.time.sleep'):
            self.assertTrue(self.r.wait_webui())

    def test_webui_polling_reuses_authentication_instead_of_repeated_login(self):
        with patch.object(self.r, 'read_json', return_value={'token': 'private-fixture'}), patch.object(self.r, 'request_json') as request:
            request.side_effect = [{'data': {'Credential': 'private-session'}},
                                   {'code': 0, 'data': {'isLogin': True, 'coreReady': True, 'loginPhase': 'ready'}},
                                   {'code': 0, 'data': {'isLogin': True, 'coreReady': True, 'loginPhase': 'ready'}}]
            self.assertTrue(self.r.channel()['qq_logged_in'])
            self.assertTrue(self.r.channel()['qq_logged_in'])
        self.assertEqual(sum(call.args[0].endswith('/auth/login') for call in request.call_args_list), 1)

    def test_failed_webui_auth_backs_off_without_reporting_qq_online_as_offline(self):
        config = self.root / 'onebot.json'
        config.write_text(json.dumps({'network': {'httpServers': [{'enable': True, 'token': 'fixture-onebot'}]}}))
        policy = {'httpUrl': 'http://127.0.0.1:3000', 'onebotConfigFile': str(config), 'expectedSelfId': 'fixture-account'}
        def read(path):
            return {'token': 'fixture-webui'} if path.endswith('webui.json') else policy
        with patch.object(self.r, 'read_json', side_effect=read), patch.object(self.r, 'request_json') as request:
            request.side_effect = [{'message': 'login rate limit'}, {'retcode': 0, 'data': {'online': True}},
                                   {'retcode': 0, 'data': {'user_id': 'fixture-account'}},
                                   {'retcode': 0, 'data': {'online': True}}, {'retcode': 0, 'data': {'user_id': 'fixture-account'}}]
            self.assertTrue(self.r.channel()['qq_logged_in'])
            self.assertTrue(self.r.channel()['qq_logged_in'])
        self.assertEqual(sum(call.args[0].endswith('/auth/login') for call in request.call_args_list), 1)

    def test_headless_browser_open_returns_an_actionable_url(self):
        output = []
        self.r.progress = output.append
        self.r.env.pop('DISPLAY', None)
        self.r.env.pop('WAYLAND_DISPLAY', None)
        with patch.object(self.r, 'run') as run:
            self.assertFalse(self.r.open_webui())
            run.assert_not_called()
        self.assertIn('http://127.0.0.1:6099/webui/', output[0])


class FrontendTest(unittest.TestCase):
    def test_status_json_never_starts_services_and_budget_wait_is_not_failure(self):
        state = {'postgres_ready': True, 'channel': {'qq_logged_in': True, 'core_ready': True},
                 'adapter': {'active': True, 'ready': True}, 'memory': {'worker_state': 'budget_wait'}, 'ready': True}
        with patch('desktop_app.cli.Runtime') as runtime, redirect_stdout(io.StringIO()) as output:
            runtime.return_value.status.return_value = state
            self.assertEqual(cli.main(['--status', '--json']), 0)
            runtime.return_value.start.assert_not_called()
            runtime.return_value.open_webui.assert_not_called()
        self.assertTrue(json.loads(output.getvalue())['ready'])
        self.assertIn('等待整理额度', cli.describe(state))

    def test_install_valid_desktop_entry_and_icon_in_user_directory(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as temp:
            destination = install(root, Path(temp))
            self.assertIn('Terminal=true', destination.read_text())
            self.assertIn('--restart-qq', destination.read_text())
            self.assertTrue((Path(temp) / 'icons/hicolor/scalable/apps/org.example.BotLife.svg').is_file())
            if shutil.which('desktop-file-validate'):
                self.assertEqual(subprocess.run(['desktop-file-validate', str(destination)], capture_output=True).returncode, 0)

    def test_desktop_command_is_quoted_without_shell_or_env_expansion(self):
        text = desktop_entry(Path('/tmp/with space/$var%percent'))
        self.assertIn('\\\\$var%%percent', text)
        self.assertNotIn('sh -c', text)
        self.assertEqual(exec_arg('/a\\b'), '"/a' + '\\' * 4 + 'b"')
        with self.assertRaises(ValueError):
            exec_arg('/tmp/a\nExec=bad')


if __name__ == '__main__':
    unittest.main()
