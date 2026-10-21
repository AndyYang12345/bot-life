"""Install a per-user freedesktop entry; no root, autostart or system changes."""
import os
from pathlib import Path
import shutil
import subprocess

APP_ID = 'org.example.BotLife'


def exec_arg(value):
    # Desktop Entry has its own quoting and %-field syntax, not shell quoting.
    value = str(value)
    if any(c in value for c in '\n\r\x00'):
        raise ValueError('invalid_desktop_path')
    escaped = ''.join('\\' + c if c in ('"', '`', '$', '\\') else c for c in value)
    return '"' + escaped.replace('\\', '\\\\').replace('%', '%%') + '"'


def desktop_entry(root):
    command = exec_arg(Path(root) / 'scripts/start-bot')
    return '\n'.join([
        '[Desktop Entry]', 'Version=1.5', 'Type=Application',
        'Name=奶鲸 Bot', 'Name[en]=NaiJing Bot', 'GenericName=QQ 机器人启动器',
        'Comment=启动必要服务、打开 NapCat 后台并查看 QQ 登录状态',
        'Exec=' + command, 'Icon=' + APP_ID, 'Terminal=true', 'StartupNotify=false',
        'Categories=Network;InstantMessaging;', 'Keywords=NapCat;QQ;OneBot;bot;奶鲸;机器人;',
        'Actions=RestartQQ;', '', '[Desktop Action RestartQQ]',
        'Name=重启 QQ 并测试自动登录', 'Exec=' + command + ' --restart-qq', '',
    ])


def install(root, data_home=None):
    root = Path(root).resolve()
    home = Path(data_home or os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share')
    if not home.is_absolute():
        raise ValueError('xdg_data_home_must_be_absolute')
    folder = home / 'applications'
    folder.mkdir(parents=True, exist_ok=True)
    destination = folder / (APP_ID + '.desktop')
    icon = home / 'icons/hicolor/scalable/apps' / (APP_ID + '.svg')
    icon.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / 'deploy/napcat-bot.svg', icon)
    temporary = destination.with_name('.' + APP_ID + '.new.desktop')
    temporary.write_text(desktop_entry(root))
    temporary.chmod(0o755)
    validator = shutil.which('desktop-file-validate')
    if validator:
        result = subprocess.run([validator, str(temporary)], capture_output=True)
        if result.returncode:
            temporary.unlink(missing_ok=True)
            raise ValueError('desktop_entry_validation_failed')
    os.replace(temporary, destination)
    updater = shutil.which('update-desktop-database')
    if updater:
        try:
            subprocess.run([updater, str(folder)], capture_output=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            pass  # The valid installed entry remains usable without the cache refresh.
    return destination
