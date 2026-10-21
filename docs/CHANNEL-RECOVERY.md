> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# QQ 登录恢复与第二群接入

核验日期：2026-10-20 至 2026-10-21（Asia/Shanghai）。本次已按博士指令接入第二个指定群，原测试群继续保留，私聊仍关闭。配置只在忽略的 `data/config/adapter.json` 中保存群号；session、近期图片和记忆边界使用各自 conversation key。

## 实际发现

1. 21:30:37，QQ 明确发出 `[KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。`。这证明该次是服务端登录态失效；日志没有进一步证明具体由哪项手机安全设置触发。
2. 21:30:41，NapCat 按内置逻辑重启 Worker；21:30:46，输出“没有 -q 指令指定快速登录，将使用二维码登录方式”。部署没有设置 ACCOUNT，WebUI 也未设置 autoLoginAccount，导致已保留的登录缓存没有被自动选中。
3. 22:09 主机重新启动后，NapCat 容器运行，但 user service 的 UnitFileState=disabled，适配器没有随用户会话自动启动。该问题与 QQ 安全开关独立。
4. `ErrType:1 / ErrCode:3` 在本次使用版本的源码中表示二维码过期，不是账号封禁或设备锁的直接证据。GPU/DBus 错误和找不到旧 crash record 也不能单独当作此次踢下线原因。
5. QQ 数据目录仍存在、可写且有可用缓存。通过已认证 WebUI 发起一次快速登录后，QQ 在没有重新扫码的情况下恢复 ready。

## 已落实

- 已在 WebUI 保存自动登录账号，Compose 通过忽略的 `.env` 中 NAPCAT_ACCOUNT 注入 ACCOUNT；实际账号不进 Git。使用已有登录票据，不存储 QQ 密码。
- 已启用 `napcat-onebot.service` 的 user default target。它在用户 systemd 会话启动时拉起；没有改变系统级登录/安全设置或开启 linger。
- 启动入口先执行 `scripts/wait-onebot`：等待已鉴权 OneBot 明确 online，核对 expectedSelfId，随后才启动 DSH。它本身不循环尝试 QQ 登录。
- 运行期健康状态分别记录 WebSocket connected 和 QQ qqOnline，离线时先保留接收队列，暂停领取新的模型任务；恢复后继续处理。
- 一次实际 Compose 重建后，QQ 自动快速登录成功，适配器回到 connected=true / qqOnline=true / database=true；博士在新增群发送 `/bot-ping` 并确认收到 pong。

若 QQ 撤销了缓存票据或要求新设备/人工验证，自动选择账号仍可能失败，此时须在手机 QQ 确认并通过本机 WebUI 重新扫码。本次没有关闭登录保护。具体风控触发原因仍需下一次踢下线时保留更完整的服务端错误信息，并与手机“登录设备/安全通知”记录对照。

## 本轮再次掉线：需要人工重新授权

22:42:55 再次实际捕获同样的登录失效通知。22:43:04，WebUI 自动快速登录已经执行，但 QQ 明确返回“你的用户身份已失效，为保证账号安全，请你重新登录。”，随后进入 waiting_qrcode。该次容器仍在运行、未重启、未 OOM；适配器正确变为 connected=false / qqOnline=false，未继续领取模型任务。

因此要区分两类问题：此前遗漏自动账号/服务自启的部署缺口已修复；**服务端使登录票据失效**仍会要求手机扫码，缓存自动登录无法保证恢复。未配置密码回退，也未关闭保护或循环重试密码。已请博士重新扫码并查看手机安全通知，当前等待人工重新授权；不能将掉线问题写成完全解决。

上游也有 [相近的频繁失效报告 #2062](https://github.com/NapNeko/NapCatQQ/issues/2062)；这是其他使用者的现象报告，不能据此判定本机由某个版本或安全开关导致。固定版的扫码刷新/离线 Worker 行为与实际账号风控需要分别验证，不通过盲目升降级推断根因。

同日后续重新登录后，QQ 与适配器曾恢复在线，23:29 实际完成两群的记忆收发验收。23:44 再次发生同类失效，见下节；此前恢复不能作为长期稳定性通过的证据。

## 23:44 再次失效：恢复边界的复核

- 23:44:27，QQ 再次发出“你的账号当前登录已失效，请重新登录”；23:44:31，NapCat 请求重启内部 Worker；23:44:36，自动快速登录被服务端以“你的用户身份已失效，为保证账号安全，请你重新登录”拒绝。
- 23:59:42，通过已鉴权 WebUI 仅重试一次缓存登录，返回 code=-1、“登录态已失效，请重新登录”，仍为 waiting_qrcode。未循环尝试，也未再次重启容器。脱敏结果保存在忽略的 evidence/channel-recovery-20261020.json。
- 此时容器从 22:54:02 起持续运行，RestartCount=0、OOMKilled=false；适配器进程存活。QQ 为 3.2.34-53644，NapCat 为 4.18.38；查询上游 latest release 仍是 v4.18.38，未发现一个可直接升级并已证实解决本机问题的新版。
- QQ 数据目录已持久化，machine-info 存在、最后修改时间为 17:36:06，早于本次容器启动及踢下线。没有证据表明本次掉线由重建容器或删除设备缓存导致；尚未比较多次事件的完整设备 GUID，也未据此排除所有设备识别因素。
- 当前容器未配置 NAPCAT_QUICK_PASSWORD 或 NAPCAT_QUICK_PASSWORD_MD5。两条固定版源码路径（首次 -q 登录和内部 Worker 重建后的 WebUI 自动登录）都实现了密码回退；验证码、新设备验证及异常设备验证仍可能要求人工操作。MD5 也应当作登录凭证保密，不能视为可公开的脱敏值。

现有自动恢复适用于进程退出、OneBot 连接中断和仍然可用的缓存登录；本次在同一登录服务中即时重试没有恢复，不能由此断言后续完整初始化也必然失败。下一步若采用密码回退，须由博士在本机录入专用小号的凭证，采用私有文件注入，遇验证或凭证错误停止自动尝试，并实际验收内部 Worker 重建后的回退路径；当前尚未配置或验证这条路径。不能把“上游支持”写成“本机自动恢复已通过”。

根因目前只能确定到 QQ 主动撤销登录态，具体触发条件尚未证明。需对照手机安全通知及登录设备，排查其他电脑客户端/机器人同时使用该账号等因素。上游 #2062 存在同类报告；当前页面显示 10 月 5 日已关闭，维护者建议先用 sl，页面未给出本机已验证的修复。评论中的降级与反检测建议不能当作已证实方案。此轮没有修改设备标识、关闭安全保护或盲目升降级。

密码回退依据：[shell 登录](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-shell/base.ts)、[WebUI 自动登录](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-webui-backend/index.ts)。

## 可选密码回退接入（2026-10-21）

博士反馈手机没有相关安全提示，也不存在其他电脑或机器人同时登录。该反馈暂未提供具体风控触发条件，不能仅凭没有提示排除服务端策略或兼容性问题。

已增加本机配置入口及可选 Compose overlay，调用固定版 NapCat 自带的密码回退，不改 QQ 登录协议，不关闭保护，也没有另建不断重启或循环提交密码的 watchdog。

```sh
# 必须在本机交互终端输入；不接收管道或命令行中的密码。
scripts/qq-login-password set
# 重新创建 NapCat 容器以装载或更新凭证；不重启主机和数据库。
scripts/napcat apply-login
scripts/check-status
scripts/onebot-adapter status
```

- 明文密码只用于本机计算登录协议要求的 MD5；摘要写入忽略的 data/config/qq-login.md5，目录权限 700、文件 600。摘要同样属于敏感登录凭证，不是加密保管或可公开的脱敏结果。
- scripts/napcat 在存在合规凭证文件时选择 deploy/login-password.yaml。文件以只读 bind mount 交给启动 wrapper，再注入 QQ 进程环境；摘要不进入 Compose 插值、Docker Config.Env 或命令行参数。主机管理员和 QQ 进程仍能访问凭证，不能把这种隔离称为对管理员保密。
- wrapper 同时设置 NAPCAT_QUICK_ACCOUNT，因为上游内部 Worker 重建不再带首次启动的 -q 参数；源码会以 ...process.env 继承回退所需变量。首次启动走 shell 回退，内部重启走 WebUI 回退，两条路径都保留账号信息。
- 上游先尝试缓存，失败后在该次登录流程中尝试密码；密码错误或需要验证码/新设备验证时仍可能回到人工处理。当前改动没有增加跨 Worker 的全局重试熔断，不能保证连续被踢时的登录频率，也不能证明已经解决踢下线根因。
- scripts/qq-login-password status 只报本机是否配置；scripts/check-status 额外区分 configured_locally / applied_to_container，并对 waiting_qrcode 提示验证或配置回退。它不把已挂载凭证当作 QQ 登录成功。
- 更换密码需重新 set 后 apply-login；停用用 scripts/qq-login-password remove 后 apply-login。删除文件本身不会清除已运行进程中的旧凭证。

本轮验证：8 项本地检查覆盖隐藏输入入口、参数不回显、凭证格式/权限、拒绝链接、Compose 选择和子进程传递；实际固定镜像的隔离容器也完成了 wrapper 传递测试（network=none，未启动 QQ），Compose 合并结构有效。**账号真实密码登录、内部 Worker 重建后登录及长期稳定性，仍须本机录入后另行验收。**

## 排查入口

```sh
scripts/check-status
scripts/onebot-adapter status
cat data/adapter/readiness.json
```

readiness 的 `waiting_service`、`waiting_qq_login`、`authentication_rejected`、`account_mismatch` 与 ready 分开呈现；不会把 WebSocket 可连接直接当作 QQ 已在线。日志中可能含口令、登录二维码或临时链接，应只在本机查看。

上游依据：[固定版 entrypoint ACCOUNT 入口](https://github.com/NapNeko/NapCat-Docker/blob/42e4f9e8373c739f4d2ee599980ab8f87cff39b6/entrypoint.sh)、[固定版 shell 登录与离线恢复](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-shell/base.ts)、[QQ 登录状态 API](https://github.com/NapNeko/NapCatQQ/blob/v4.18.38/packages/napcat-webui-backend/src/api/QQLogin.ts)。

## 本机配置后的实际结果（2026-10-21 00:07–00:09）

博士已通过本机隐藏输入保存凭证。00:07 应用 overlay 并重建 QQ 容器后，WebUI 为 ready、qq_logged_in=true、core_ready=true；适配器自动恢复 connected=true / qqOnline=true / database=true，无待处理 spool。摘要文件权限为 600，容器只读挂载，Docker Config.Env 不含摘要值。

该次启动日志仅观察到缓存快速登录，没有密码失败或密码回退成功日志；随后在适配器空闲时调用一次已鉴权 RestartNapCat，00:09:10 明确记录“自动快速登录成功”，QQ 和适配器再次自动回到在线。因此，**完整容器初始化和内部 Worker 重建后的缓存恢复均已实测；真实密码回退分支尚未触发验收。**不能把本轮上线归功于密码认证已成功。

新增事实也说明：前一次 WebUI 即时重试返回登录态失效，不能推导为缓存已永久不可用或只剩扫码。完整进程初始化、登录服务状态及服务端策略均应继续作为可能因素。没有为验证密码而删除现有登录缓存或故意使票据失效；后续若实际触发密码回退，再分别记录密码成功、需要验证码、需要设备验证或密码错误。当前掉线触发根因仍未查明，24 小时稳定性仍未通过。脱敏证据位于忽略的 evidence/qq-password-deployment-20261021.json。

## 00:34 的真实密码回退：需要验证码

2026-10-21 00:34:45 再次捕获相同登录失效；00:34:54 缓存登录被拒后，日志明确进入“正在密码登录”，00:34:55 QQ 返回需要验证码，自动路径停止并提示在 WebUI 完成。由此可确认密码回退分支实际已触发，但尚未通过密码完成重新登录。后台记忆开发期间没有循环提交密码；已请博士在本机 WebUI 验证或重新扫码，不能把验证码要求写成密码已验证正确或自动恢复成功。

同日后续博士完成了本机验证或重新登录。00:42–00:43 复核 QQ 为 ready，适配器在记忆后端部署重启后自动回到 connected=true / qqOnline=true；不能据此区分此次人工采用了验证码还是扫码，也不能称为全自动通过验证码。
