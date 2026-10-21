> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# 奶鲸 Bot：终端启动器

本机应用列表入口为“奶鲸 Bot”，可搜“奶鲸”或“NapCat”。这是终端前端，打开浏览器中的 NapCat 后台；尚未开发 Qt6 窗口或记忆库可视化。

## 使用

点击应用后依次检查 Docker、启动独立 PostgreSQL 并等候健康、启动 NapCat、启动 OneBot 适配器和记忆整理 user service。后台就绪后打开 http://127.0.0.1:6099/webui/，终端持续显示 QQ 登录及适配器状态。默认终端由桌面环境选择。

普通启动是幂等操作，已运行的 QQ 不主动重启。已配置的账号缓存、密码回退和模型密钥沿用原服务配置；不修改账号、镜像、数据库 schema、记忆、群白名单或人设。Docker 未启动时尝试由系统服务启动，系统可能要求本机认证；无权限时显示失败，不执行 sudo 或反复尝试。

| 终端按键 | 行为 |
|---|---|
| 回车 | 刷新状态 |
| O | 再次打开 NapCat 后台 |
| R | 输入 r 确认后重启 QQ，测试缓存／密码回退；短暂断连，保留持久数据 |
| T | 只在本机终端显示 NapCat WebUI 口令，便于进入管理页；不同于 QQ 密码，请勿分享 |
| Q / Ctrl+C / 关闭窗口 | 退出启动器，已启动的后台服务继续运行 |

桌面右键动作“重启 QQ 并测试自动登录”直接执行重启路径。不会删除登录缓存，也不循环提交密码；遇扫码、验证码或新设备验证时，需在浏览器中完成。QQ 登录成功后，既有 wait-onebot 自动接入，启动器也会更新状态。重复点击启动使用独占操作锁；没有同时启动多份 QQ/DSH 进程。

“服务已启动”与“QQ 已登录”分别显示。适配器状态会核对健康文件是否属于当前服务进程，避免重启后显示旧的在线结果。记忆整理 budget_wait 显示“等待整理额度”，不是启动失败。启动日志仅保存动作名、成功与否和时间，不复制 Docker 原始输出、口令、登录链接或聊天。

后台刷新复用内存中的认证会话，失败时至少等待 65 秒才重新认证，避免每五秒刷新导致 NapCat 登录限流。后台认证暂不可用时，额外通过有鉴权的 OneBot 接口核验在线状态及账号；不会仅凭旧健康文件声称在线，也不将 WebUI 认证失败直接当作 QQ 离线。

## 安装与命令行

    scripts/install-desktop-app
    scripts/start-bot
    scripts/start-bot --restart-qq
    scripts/start-bot --status --json
    scripts/start-bot --once --no-browser

安装器将 .desktop 写到当前用户 XDG_DATA_HOME/applications（默认 ~/.local/share/applications），图标放在同目录树的 icons/hicolor/scalable/apps；安装不会增加开机启动项。工作空间移动后应重跑安装器刷新绝对路径。

终端前端关闭不等于停服。需要停服时使用原有 scripts/onebot-adapter stop、scripts/memory-worker stop 和 scripts/napcat stop；不要通过关闭启动窗口判断 QQ 是否已退出。

--status 为只读，--json 提供后续 Qt6 可直接调用的结构化状态，不返回凭据。正常 --once 在全链路 ready 时返回 0，服务已启动但 QQ 尚未登录时返回 1；这不等于启动命令失败。Qt6 前端后续可复用 desktop_app/runtime.py 的服务操作，另接受控的记忆查询接口。

入口依据：[freedesktop Desktop Entry](https://specifications.freedesktop.org/desktop-entry/latest/)。Exec 使用桌面规范的路径引用，不经过 sh -c；Terminal=true 交由系统终端承载。

## 本机验证（2026-10-21）

- 启动顺序、独占锁、数据库失败即停止后续步骤、重启失败恢复适配器、旧健康文件隔离、无图形环境降级、只读 JSON、安装格式、认证复用与限流退避已通过 13 项检查。
- 实际普通启动已执行：数据库与两个 user service 运行，NapCat 容器 ID/StartedAt 未变化，验证普通点击不重启已运行 QQ。
- 应用入口经 desktop-file-validate 校验并通过 gtk-launch 调起；博士确认终端与后台都已打开。
- 博士测试重启后的结果为“需要扫码或验证码”。因此本次桌面入口可用，但自动 QQ 登录未通过，不能把口令回退已配置当作自动登录成功；需要在 WebUI 完成人工验证。
- 随后只读复核 QQ 和 OneBot 已在线、账号匹配；这是后续恢复状态，不据此反推最初自动登录通过。
- 状态与启动证据保存在本机忽略的 evidence/desktop-launcher-20261021.json。未向 QQ 群发测试消息。
