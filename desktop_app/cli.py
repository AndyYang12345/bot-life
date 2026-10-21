"""Terminal frontend. Closing it does not stop background user services."""
import argparse
import json
import select
import subprocess
import sys
from .runtime import LaunchError, Runtime, WEBUI


def describe(state):
    channel = state['channel']
    phase = channel.get('login_phase')
    qq = '已登录' if channel.get('qq_logged_in') and channel.get('core_ready') else {
        'waiting_qrcode': '等待扫码／安全验证', 'offline': '离线',
        'logging_in': '正在登录', 'password_login': '正在尝试密码登录',
    }.get(phase, '等待登录／服务就绪')
    adapter = '已连接' if state['adapter']['ready'] else '已启动，等待 QQ 就绪' if state['adapter']['active'] else '未运行'
    memory = {'idle': '运行中', 'processing': '正在整理', 'budget_wait': '等待整理额度',
              'paused': '已暂停', 'disabled': '未启用', 'starting': '正在启动',
              'stopped': '未运行', 'waiting_retry': '等待重试', 'error': '配置／数据库异常'}.get(state['memory']['worker_state'], '运行中')
    return ('数据库：' + ('就绪' if state['postgres_ready'] else '未就绪')
            + ' ｜ QQ：' + qq + ' ｜ 适配器：' + adapter + ' ｜ 记忆：' + memory)


def main(argv=None):
    parser = argparse.ArgumentParser(description='奶鲸 Bot — 本机服务启动与登录测试')
    parser.add_argument('--status', action='store_true', help='只读状态，不启动服务')
    parser.add_argument('--json', action='store_true', help='配合 --status，供后续图形界面调用')
    parser.add_argument('--no-browser', action='store_true', help='不打开浏览器')
    parser.add_argument('--once', action='store_true', help='显示一次状态后退出，不显示终端菜单')
    parser.add_argument('--restart-qq', action='store_true', help='重新启动 QQ，测试自动登录')
    args = parser.parse_args(argv)
    if args.json and not args.status:
        parser.error('--json 仅与 --status 一起使用')
    if args.status and args.restart_qq:
        parser.error('--status 与 --restart-qq 不能同时使用')
    runtime = Runtime()
    interactive = sys.stdin.isatty() and not args.once and not args.status
    previous = None
    try:
        if not args.status:
            print('奶鲸 Bot · 终端启动器', flush=True)
            print('正在使用本机既有配置；关闭本窗口后，服务继续运行。', flush=True)
            runtime.start(args.restart_qq)
            if not args.no_browser:
                print('等待 NapCat 后台可访问…', flush=True)
                if not runtime.wait_webui():
                    print('后台仍在启动，稍后可按 O 打开。', flush=True)
                runtime.open_webui()
        while True:
            state = runtime.status()
            if args.json:
                print(json.dumps(state, ensure_ascii=False))
                return 0
            rendered = describe(state)
            if rendered != previous:
                print('\n' + rendered, flush=True)
                if not state['channel'].get('qq_logged_in'):
                    print('若 QQ 要求验证，请在 NapCat 后台扫码／完成验证；启动器不会循环提交密码。', flush=True)
                previous = rendered
            if not interactive:
                return 0 if state['ready'] else 1
            print('\n[回车]刷新  [O]打开后台  [R]重启QQ测试自动登录  [T]查看本机后台口令  [Q]关闭窗口', flush=True)
            # Keep observing login completion without requiring another click.
            while not select.select([sys.stdin], [], [], 5)[0]:
                current = runtime.status()
                if describe(current) != previous:
                    previous = describe(current)
                    print('\n' + previous, flush=True)
            choice = sys.stdin.readline().strip().lower()
            if choice == 'q':
                print('已关闭启动窗口，后台服务继续运行。')
                return 0
            if choice == 'o':
                runtime.open_webui()
            elif choice == 'r':
                print('将重启 QQ 容器，已有连接会短暂断开；不删除账号缓存或记忆。')
                if input('输入 r 确认，其他键取消：').strip().lower() == 'r':
                    runtime.start(True)
                    if not args.no_browser:
                        runtime.wait_webui()
                        runtime.open_webui()
                    previous = None
            elif choice == 't':
                # Intentionally visible only in the user's local terminal; never audited.
                print('NapCat 后台口令（不同于 QQ 密码，请勿分享）：')
                subprocess.run([str(runtime.root / 'scripts/show-webui-token')], env=runtime.env)
    except LaunchError as error:
        print('\n启动未完成：' + str(error), file=sys.stderr)
        print('NapCat 后台：' + WEBUI, file=sys.stderr)
        if interactive:
            input('按回车关闭窗口；已经启动的服务保持运行。')
        return 1
    except (KeyboardInterrupt, EOFError):
        print('\n已退出启动器；已经启动的后台服务保持运行。')
        return 0


if __name__ == '__main__':
    sys.exit(main())
