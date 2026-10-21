"""Security and deployment checks for the optional native password fallback."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = runpy.run_path(str(ROOT / "scripts/qq-login-password"))


class PasswordConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.secret = self.directory / "qq-login.md5"

    def tearDown(self):
        self.temp.cleanup()

    def test_only_digest_is_saved_and_file_is_private(self):
        password = "unit-test-口令-$()"
        HELPER["save_password"](self.secret, password)
        self.assertEqual(HELPER["read_digest"](self.secret), hashlib.md5(password.encode()).hexdigest())
        self.assertNotIn(password, self.secret.read_text())
        self.assertEqual(self.secret.stat().st_mode & 0o777, 0o600)
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), [self.secret.name])

    def test_public_permissions_are_rejected(self):
        self.secret.write_text("a" * 32)
        self.secret.chmod(0o644)
        with self.assertRaises(ValueError):
            HELPER["read_digest"](self.secret)

    def test_links_and_public_parent_are_rejected(self):
        target = self.directory / "original"
        target.write_text("original")
        self.secret.symlink_to(target)
        with self.assertRaises(OSError):
            HELPER["read_digest"](self.secret)
        with self.assertRaises(ValueError):
            HELPER["save_password"](self.secret, "test")
        self.assertEqual(target.read_text(), "original")
        self.secret.unlink()
        self.directory.chmod(0o755)
        with self.assertRaises(ValueError):
            HELPER["save_password"](self.secret, "test")

    def test_invalid_or_oversized_digest_is_rejected(self):
        for value in ("", "not-a-digest", "a" * 32 + "\nEXTRA=bad", "a" * 32 + " " * 128):
            self.secret.write_text(value)
            self.secret.chmod(0o600)
            with self.assertRaises(ValueError):
                HELPER["read_digest"](self.secret)

    def wrapper(self, digest, account="1234"):
        self.secret.write_text(digest)
        env = {k: v for k, v in os.environ.items() if not k.startswith("NAPCAT_QUICK_")}
        env.update(NAPCAT_QQ_PASSWORD_FILE=str(self.secret), ACCOUNT=account)
        # The child prints booleans only; credentials must never reach output.
        child = "import os,json;print(json.dumps({'digest':len(os.environ.get('NAPCAT_QUICK_PASSWORD_MD5',''))==32,'account':os.environ.get('NAPCAT_QUICK_ACCOUNT')==os.environ.get('ACCOUNT'),'plaintext':'NAPCAT_QUICK_PASSWORD' in os.environ}))"
        return subprocess.run(["bash", str(ROOT / "deploy/login-entrypoint.sh"), "python3", "-c", child],
                              env=env, capture_output=True, text=True)

    def test_wrapper_passes_credential_to_child_without_printing_it(self):
        digest = "ab12" * 8
        result = self.wrapper(digest + "\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(digest, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout.splitlines()[-1]),
                         {"digest": True, "account": True, "plaintext": False})

    def test_wrapper_refuses_invalid_secret_and_missing_account(self):
        for value, account in (("bad-input", "1234"), ("a" * 32 + "\nX=bad", "1234"), ("a" * 32, "")):
            result = self.wrapper(value, account)
            self.assertEqual(result.returncode, 78)
            self.assertNotIn(value, result.stdout + result.stderr)
            self.assertNotIn('"digest"', result.stdout)

    def test_no_password_is_accepted_from_pipe_or_arguments(self):
        result = subprocess.run([str(ROOT / "scripts/qq-login-password"), "set"],
                                input="do-not-read-me\n", capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("do-not-read-me", result.stdout + result.stderr)
        result = subprocess.run([str(ROOT / "scripts/qq-login-password"), "set", "do-not-echo-me"],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("do-not-echo-me", result.stdout + result.stderr)

    def test_compose_overlay_is_selected_only_for_configured_secret(self):
        # Exercise the actual shell command construction in an isolated checkout.
        for name in ("scripts", "deploy", "bin"):
            (self.directory / name).mkdir()
        for name in ("napcat", "qq-login-password"):
            shutil.copy2(ROOT / "scripts" / name, self.directory / "scripts" / name)
        docker = self.directory / "bin/docker"
        docker.write_text('#!/usr/bin/env python3\nimport sys,json;print(json.dumps(sys.argv[1:]))\n')
        docker.chmod(0o700)
        env = dict(os.environ, PATH=str(docker.parent) + os.pathsep + os.environ["PATH"])
        command = [str(self.directory / "scripts/napcat"), "apply-login"]
        result = subprocess.run(command, env=env, capture_output=True, text=True, check=True)
        self.assertNotIn("login-password.yaml", result.stdout)
        self.assertEqual(json.loads(result.stdout)[-3:], ["up", "-d", "--force-recreate"])
        HELPER["save_password"](self.directory / "data/config/qq-login.md5", "isolated-test-password")
        result = subprocess.run(command, env=env, capture_output=True, text=True, check=True)
        self.assertIn("login-password.yaml", result.stdout)
        self.assertNotIn(hashlib.md5(b"isolated-test-password").hexdigest(), result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
