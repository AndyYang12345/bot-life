> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# 通用网页搜索与正文阅读

2026-10-21，按开发路线第 2 项实现。模型在已授权群的有效回合中可自行调用 web_search / web_fetch；观察消息、普通闲聊不会由适配器自动发起网页请求。沿用既有 attention、串行任务、租约和 outbox。

## 实现与来源

搜索和正文读取均走 DeepSeek 官方的新原始 JSON API，使用本 bot 已有独立 DEEPSEEK_API_KEY：

- `POST https://api.deepseek.com/v1/tools/search`：query 最多 128 个 Unicode 字符，请求 5 条来源，只取标题、摘要、发布日期和来源 URL。
- `POST https://api.deepseek.com/v1/tools/fetch`：传入公开网页 URL，返回 Markdown 正文。每次默认展示 4000 字符，可选 500～8000；next_start 用于继续读取同一快照。

依据：[官方 Search / Fetch 指南](https://api-docs.deepseek.com/guides/search/)、[Search schema](https://api-docs.deepseek.com/api/search/)、[Fetch schema](https://api-docs.deepseek.com/api/fetch/)。本次没有采用 DSH 旧的 Anthropic Messages 辅助搜索：它需要额外模型调用，原始 Search API 已能直接返回结构化资料。公开 HTML 搜索试探出现验证码或不相关结果，没有作为生产兜底，也不规避访问限制。

搜索摘要不等于已读正文；网页是外部不可信资料，不能成为系统指令或当前发言人的记忆证据。模型应优先读取权威原始来源，简短回答并引用实际来源，区分发布日期与 retrieved_at。空搜索、无正文、登录/访问拒绝、限流、超时均返回安全错误码，不编造成功。

正文每页最多保留 100000 字符，超过时 source_truncated=true；HTTP 响应上限 2 MiB。页快照只在取得后的 5 分钟内可续读，全进程至多保留 10 个快照，过期快照在下一次工具调用时清理。缓存键包含 job ID，跨群/新消息不能复用前一轮快照。续读不重复请求 Fetch API，但仍计入回合工具调用上限。快照过期时必须从 start=0 重新读；next_start=null 且 source_truncated=true 也不能声称读完整页。

## 网络和凭据边界

模型不能指定 HTTP 头、Cookie、账号、API endpoint 或其他会话。所有带密钥的请求只到固定的 api.deepseek.com 两个 API，禁止 HTTP 重定向，不继承其他个人搜索密钥。网页 URL 只是 JSON 参数，密钥不会发到网页站点。没有更改 DSH profile、模型设置或 model.env。

网页仅允许 HTTP(S)、80/443 端口，拒绝 URL 用户名/密码、localhost、局域网后缀、私网/loopback/link-local/保留地址及 IPv4 映射。调用 Fetch 前核对本机 DNS 返回的全部地址；包含非公网地址就拒绝。网页实际下载由 DeepSeek 远端执行，受官方的目标站点和抓取安全策略约束；本机 DNS 检查不等于固定了远端 DNS。本模块不会从本机直接向任意网页 URL 建立连接，只有 DNS 和官方 API 请求。

明显的 sk- 密钥、Bearer 值或密码/令牌赋值拒绝作为搜索词或 URL；模型只应发送问题必需关键词，不上传群聊记录、QQ号或个人记忆。本地不执行网页 JavaScript，不登录、不解验证码、不提供完整浏览器、PDF OCR、音视频理解或站点写操作；B 站仍走 bili 工具。

## 额度和观测

私有 data/config/adapter.json 新增：

```json
"web": {"enabled": true, "maxPerHour": 20, "maxPerDay": 100}
```

模板默认关闭；启用或修改后重启适配器。默认全实例所有授权群共享滚动 1 小时 20 次 / 24 小时 100 次预算，每轮最多 6 次工具调用（含续读）。网络操作 30 秒超时，不自动重试。额度预留保存在现有 life_rates，跨群和进程重启不重置；无需数据库迁移。无效租约或 pause 时拒绝新预留，完成后再次核验租约，取消不返回正文。

预留按尝试计数，失败或进程中断也可能占额度，不能当作实际账单。web.requested / web.completed 记录请求 ID、操作、结果、来源和独立凭据标签；web.read 记录实际阅读范围和是否命中快照，不记录密钥或 HTTP 原始错误。

`scripts/life-admin usage` 的 webRequests 分开统计 reserved、succeeded、nonempty、failed，不混入模型 token，也不估算费用。官方 Search/Fetch 依成功请求计费，具体以账户账单和最新官方说明为准，沿用 bot 独立密钥管理。

## 验证与部署边界

完整检查 234 项通过：Life Core 129、适配器 84、启动器 13、B 站后端 8。覆盖真实 PostgreSQL 外部额度并发/跨群/重启/每日限制、pause/租约、独立网页请求统计，以及固定密钥目的地、地址/输入过滤、读取限制、正文快照、取消和失败隐藏。

实际官方接口已搜索并读取树莓派官方新手文档。真实 DSH + 本 bot 模型 API + 真实 Search/Fetch + 独立 PostgreSQL + 本地模拟 OneBot 验收通过：观察给别人的链接不请求；模型实际搜索、打开官方正文并回答 Raspberry Pi Imager，附来源；本地 NapCat 地址没有被抓取；网页请求统计为一次搜索和一次抓取。

以上隔离验收没有向真实 QQ 发送消息，证据位于忽略的 evidence/web-runtime.json。

随后在现有三个授权群启用 web 工具，仅重启适配器，QQ 持续在线。博士在测试群群实测，确认“回复正确，附有来源”；正式账本中的网页请求、正文阅读范围和发送回执另存于 evidence/web-production-acceptance.json。配置修改前的私有备份在 backups/adapter-before-web-TIMESTAMP.json。
