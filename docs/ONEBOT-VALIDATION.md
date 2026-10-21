> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# OneBot 本地功能验证

日期：2026-10-20，时区 Asia/Shanghai。范围：仅“测试群”群。使用已部署的 NapCat 4.18.38 普通 QQ 账号通道；未接入 DSH，也不启用自动回复。

## 验证规则

博士在当前会话明确授权两条消息：`NapCat 连通测试`、`NapCat 后台发送测试`。脚本不会向其他群发送，也不会对测试群消息逐条回复。第二条必须在监听到的连续群内静默达到 330 秒后发送；收到新群消息则重新计时。

脚本为 `scripts/verify-onebot`，使用一次性报告与进程锁防止重复发送；接口结果不明时不自动重试。已有报告时拒绝重跑。后续再次发送测试消息需要新的明确测试范围和授权。

## 已确认

- 账号在线、NapCat 核心 ready。
- HTTP 无 token/错误 token 均返回 403；正确 token 可执行只读 get_status。
- WebSocket 无 token/错误 token 返回 retcode 1403 并断开；正确 token 可调用只读 get_status。
- 第一条连通测试获 API 成功响应；博士在接收端确认可见。
- WebSocket 收到测试群文字消息；本地证据只记录时间和消息段类型，不保存原文。
- 账号独立配置仍设置 token，WebSocket reportSelfMessage=false。
- 连续群内静默超过 330 秒后，后台发送第二条测试消息，API 返回成功，博士在接收端确认可见。普通账号通道的无近期消息发送已通过此次实测；不代表官方 bot API 获得相同能力。

后台测试状态为 completed，两条消息均获 API 接受并由博士确认可见，测试脚本已退出。具体时间以 `evidence/functional-test.json` 为准；接收端可见性记于 `evidence/recipient-confirmations.json`。二者分别表示 API 接受和人工可见确认，不混同。

## 后续检查

- 图片消息事件，以及获取图片文件/URL后能否实际读取。
- 引用消息段，以及 get_msg 是否能解析被引用消息。
- 普通账号掉线恢复、重启登录和 24 小时稳定性。
- 后续 DSH adapter 的群白名单、身份隔离、工具边界与每群串行队列。

## DSH 适配器首版进展

2026-10-20 后续已实现独立插件 `dsh-onebot/` 并启动 user service `napcat-onebot.service`。scope/account/peer 会话键、白名单、队列、持久去重和预算、受限图片工具已实现；17 项单元与 wire 测试通过。

18:12 的授权真实消息样本通过显式一次性 replay 进入 DSH，引用图片下载成功，模型调用 read_image 后发回图片描述；博士在飞书回复“描述正确，实时测试已发”。18:14 的实时文字经 WebSocket 完成新一轮模型回复，期间独立服务已重启并恢复 session。引用图片的描述也经本开发会话查看原图核对，主要视觉要素一致。

首次调用发生于当前服务启动前的图片引用样本回放；实时文字通过 live WebSocket。18:19:40 直接图片 live 样本已到达（images=1、quotes=0、mediaFailures=0），18:19:43 完成 read_image/模型回复/发送，博士通过飞书确认“成功看到回复”。验收摘要见 `evidence/adapter-acceptance.json`。

cc-connect 已按博士要求停止：MainPID=0、inactive。飞书请求与回复通过 lark-cli bot 身份访问同一 P2P 会话，不依赖 cc-connect。

当前验证脚本通过 Python websockets 10.4 连接本机接口，未改变系统 Python 包配置；正式适配器应在自身项目中固定依赖。

## 4. 当前基础层阶段

后续已实现独立 Life Core 包与 PostgreSQL 账本/可恢复队列，详见 [LIFE-CORE-FOUNDATION](LIFE-CORE-FOUNDATION.md)。17 项为首版适配器的历史测试数，当前完整检查使用 `scripts/check-project`。

按博士最新指令，后续测试直接在本 Codex 聊天协作，不再通过飞书；cc-connect 保持暂停。历史验收记录保留原有事实和日期。
