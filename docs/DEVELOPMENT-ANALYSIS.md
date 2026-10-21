> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# QQBot Life：现状核验与开发路线

日期：2026-10-20。依据：`QQBOT-LIFE-PRD.md` v0.1、当前源码、安装包文档及官方资料。本文是分析与建议，不代表功能已经上线；未修改运行配置、重启进程或发送 QQ 测试消息。

## 1. 结论

方向成立：保留 DSH 作为运行时、QQ 作为适配器，用独立 `qqbot-life` 承载连续记忆、自我、关系和反思。当前交付的是聊天通道基线，尚不是 Life Core。

下一步应先实现“消息可靠落库、可追溯、可删除、可恢复”的纵向闭环，再实现记忆和人格连续性。不要先扩展 MCP、自编写技能或自升级。

最重要的外部约束：腾讯官方文档源码顶部声明，自 2025-04-21 起不再提供主动推送。PRD 的定时群发、主动性验收以及代码的主动发送降级均需要重新核验，不能仅按旧限额实现。

## 2. 当前状态与证据

| 项目 | 本轮核验 | 含义 |
|---|---|---|
| 源码 | `dsh-qqbot`，`custom/autonomous`，HEAD `8a489cb`，工作树干净 | 与 PRD 基线吻合 |
| 插件版本 | `@tencent-connect/dsh-qqbot` 0.5.2 | 这是插件版本 |
| QQ SDK | 实际安装 `@tencent-connect/qqbot-nodejs` 1.0.5，manifest 声明 `^1.0.5` | PRD 将 SDK 写成 0.5.2，需要更正 |
| DSH | 当前安装 0.2.0-rc.2；Node 24.19.0 | 后续按实际安装 API 接入 |
| 基线验证 | `pnpm test`：14 个文件、118 项通过；`pnpm exec tsc --noEmit`：退出码 0 | 单测和类型检查通过，未做完整构建及群端验收 |
| 当前配置 | replyAll=true、questionsOnly=false、historyLimit=40、maxQueue=50 | 每条消息完整运行 agent，存在排队和成本压力 |
| 媒体 | 当前 ttlHours=24 | 不能直接承担 PRD 30–90 天媒体归档 |
| 访问 | 群聊和私聊均 open | Life 数据上线前应明确记录范围 |
| 运行 | 观察到匹配 QQ profile 的运行进程；用户 systemd bus 不可连接 | 只能确认进程存在，不能确认连接、消息投递或服务托管状态 |

已有：群消息接入、引用和附件处理、原生看图与描述工具、session 创建/恢复、reset、模型/preset 命令、问答与审批通道、发送回声过滤、启动脚本锁和工具限制。

没有：独立 Life Ledger、长期记忆服务、版本化 self/relationship、记忆检索注入、反思 worker、管理闭环和 Life 数据备份迁移。

注意：DSH 本身有 session 持久化和恢复能力，不能说项目“完全不保存会话”。但它保存的是运行时会话，不能替代覆盖未触发 agent 的消息、命令、媒体和平台投递结果的全量 Ledger。

关键代码：

- `dsh-qqbot/src/gateway/middleware-setup.ts`：过滤、历史、命令、注意力、队列、引用和附件的顺序。
- `dsh-qqbot/src/features/autonomous.ts`：reply-all、旧判定器、失败分支。
- `dsh-qqbot/src/transport/inbound.ts`：上下文组装与 followup。
- `dsh-qqbot/src/gateway/bootstrap.ts`：SDK 发送包装、session/event 订阅、工具 guard。
- `dsh-qqbot/src/transport/events.ts`：tool call/result 等事件归一化。
- `dsh-qqbot/src/session/session-manager.ts`：session 恢复、preset、reset、模型切换。

## 3. 实施前必须处理的差异

### 3.1 QQ 主动推送属于能力阻塞项

[腾讯官方发送消息文档源码](https://raw.githubusercontent.com/tencent-connect/bot-docs/main/docs/develop/api-v2/server-inter/message/send-receive/send.md) 顶部明确标注主动推送自 2025-04-21 起不再提供；下方仍有旧额度文字，两者存在文档历史残留。应优先采用顶部公告约束，并以当前应用控制台权限及受控实测确认实际资格。

影响：

- FR-6 内部反思、目标和 open threads 可以实施。
- 定时向 QQ 群发消息暂列“平台能力待确认”，不能承诺每日主动几条。
- “主动参与当前群对话”与“无有效用户消息时主动推送”应分开命名。
- `bootstrap.ts` 当前允许被动回复超限/过期后转主动；需要改成显式能力开关、可观测失败和待投递状态，不能默认推送成功。
- 官方源码列群聊被动窗口为 5 分钟、单聊 60 分钟，而 `ReplyLimiter` 当前统一按首次记录起 1 小时判断。后续按 scope 和原消息时间建模，并核验实际平台行为。

替代体验：后台形成想接的话题，等下一条有效群消息到来时自然接回；其他平台主动通知另行接入。

### 3.2 Ledger 必须比命令、限流和发言门控更早

当前顺序简化为：

```text
selfEcho/dedup → access → history → mention → sanitize → rateLimit
→ command → questionAnswer → autonomousGate → queue
→ quoteRef → attachmentProcessor → envelope → handleInbound
```

若在 `handleInbound` 或 autonomousGate 后记录，将漏掉未发言、命令消费、问答消费、限流和队列丢弃的消息。

建议流程：

```text
校验/去重/回声/access/记录策略
  → 原始事件持久接收
  ├→ 异步引用解析、媒体归档、内容提取 → 追加富化事件
  ├→ 命令/问答处理
  └→ 轻量感知 → 发言策略 → 队列 → 检索 → agent
                                      → 发送意图 → 平台回执/失败
```

“全量”定义为：平台实际投递到本实例、通过访问与记录策略的唯一业务事件。平台未推送的历史无法补造；回声、重复、拒绝和丢弃需要分类计数，不应计为应答成功。

### 3.3 异步与不丢消息需要明确交接点

`void insert()` 或内存队列无法提供崩溃恢复。推荐短时等待本地持久 spool 的追加确认，随后异步批量写 PostgreSQL；或者等待 PostgreSQL 的短事务提交，失败时回退持久 spool。首批实现先选择一种，统一幂等键。

定义 DB 故障、磁盘满、spool 满、退出排空和死信策略。不宣称 exactly-once：接收/处理按 at-least-once + 幂等实现；平台未确认送达时保留 unknown 状态，不能盲目重发。

### 3.4 当前判定器不满足目标 attention

- gate 早于 quoteRef/附件下载，判定 prompt 仅包含文本、历史和附件标签。
- 图片旁路是交给完整 agent 看图，并不是判定器已看到图像语义。
- LLM 抛错/超时会返回不回复；无模型/解析失败才有部分 heuristic，与 FR-5.6 不一致。
- 当前二值 reply 不足以描述目标策略。

建议把“是否发言”和“是否候选记忆”拆开：`speak | observe | ignore` 加独立 `memoryCandidate`。否则互斥的 remember 与 speak 无法表达“说话同时记住”。群聊回复与候选记忆的最终授权仍由系统边界控制。

### 3.5 单实例与管理身份需要统一

- `run-qqbot.sh` 有 flock；`qqbot.service` 的 ExecStart 直接运行 node，绕过锁。后续统一唯一启动入口，并验证第二实例被拒绝。
- @bot 是触发条件，不是管理员鉴权。检查到 `/model` handler 没有 owner 校验；管理命令、审批和以后 self 核心修改必须按可信 sender ID 在服务端授权。
- 目前 guard 是已知工具名拒绝表；未知工具名默认通过。开放 Life/MCP 前建立按 scope、风险和身份控制的能力注册表。
- guard 服务缺失当前仅 warning，未来受限 profile 应在关键策略缺失时拒绝启用相应能力。
- 当前 cwd、假 HOME 和工具 guard 属应用层限制；不能代替独立用户/容器边界。

### 3.6 删除需要覆盖派生内容和旧 session

PRD 同时要求永久原文审计与按人删除，仅加墓碑不等于删除原文。建议明确：

- agent forget：逻辑遗忘，正常检索不再返回，保留受控版本。
- 管理员隐私删除：清除或不可逆脱敏原文、raw、媒体、向量、revision 内容、缓存和派生摘要；只保留无正文的删除审计。
- DSH 历史会话和 prompt snapshot 也可能含已删除内容；需重建/轮换受影响会话或使用支持的删除方案，避免从旧上下文再次召回。
- 后台任务执行前检查删除版本，防止重试把已删除内容重新写回。
- 备份恢复后先应用删除清单，再开放检索。

`/new` 保持“切换会话”，不能悄悄扩展成删除长期记忆；另设明确的遗忘/删除入口。

## 4. 数据与集成设计建议

### 4.1 保留一个 PostgreSQL，先不拆微服务

`packages/qqbot-life` 内按 domain/storage/retrieval/runtime/admin 划分；后台 worker 可先共享 domain 包、独立进程运行。初期直接注册 DSH 工具，MCP 作为后续薄适配层，不复制一套业务规则。

数据库迁移建议先采用版本化 SQL + PostgreSQL 驱动，固定依赖和容器镜像版本；向量与全文能力集中在 PostgreSQL，不立即增加独立向量库或消息中间件。

### 4.2 正式 migration 补齐约束

| PRD 草案问题 | 建议 |
|---|---|
| message_id 全局 unique | 按 platform/account/scope/peer/direction 定义平台消息键，消息类 partial unique；工具事件按 session/turn/callId/事件类型去重 |
| 一个消息只对应一行 | 区分源消息、接收、富化、工具、发送尝试、平台确认；用 correlation_id/causation_id 串联 |
| `sha256 unique` 且 media 带单个 event_id | 拆媒体 blob 与 event-media 关联表，支持一图多消息和引用计数 |
| facts/episodes 缺稳定隔离列 | 补 self_id、account_id、scope、peer_id、visibility；查询身份由会话绑定，不接受模型任意指定群 |
| source_event_ids 只用数组 | 证据关联表提供外键和删除传播；数组仅作返回格式 |
| self 的 is_current | partial unique 约束保证每个 self 只有一个 current；expected revision 防并发覆盖 |
| embedding 仅写 vector | 指定模型、维度、版本、状态；模型更换安排重建，不混合不同空间 |
| 审计 append-only | 分离不可变事件与可变处理状态/水位；富化追加事件，删除走单独受控管理路径 |

并发方面，bot 与 worker 已是两个可能的写入者；无需追求“DB 单写者”，应使用事务、唯一约束、revision CAS 和可恢复任务租约。

### 4.3 中文检索先做小样本验证

FTS 的 `tsvector` 不是中文分词方案。[PostgreSQL 16 parser 文档](https://www.postgresql.org/docs/16/textsearch-parsers.html) 说明内置 parser 的分词职责；本项目需额外用中文昵称、梗、短句验证分词效果。

建议：先固定应用层中文分词及别名索引，搭配 simple FTS；使用支持中文的 embedding provider，保留关键词检索降级。embedding 供应商、维度、价格和数据出境范围尚未选定，不能假定聊天模型已提供 embedding。

[pgvector 官方说明](https://github.com/pgvector/pgvector#filtering) 指出近似索引过滤可能导致结果不足。单群早期优先带权限过滤的精确向量检索，扩大后再测 HNSW/iterative scan。关键词与向量结果先用 RRF 融合，recency/importance 作有限加权，保留证据与冲突双方。

### 4.4 DSH 接入按当前包能力验证

- `dsh-system-prompt` 实际提供 `section/context` 和 scope-aware `system-prompt/assemble`；不能假定回调天然含 peerId/sessionId。通过服务端绑定的 session scope 查 Life 上下文，禁止全局可变“当前群”变量。
- self 核心锚点作为可信 persona；群聊产生的记忆进入标明来源的动态 context，不提升成系统指令。
- `dsh-skill` 是注册表，目录变化依赖 provider invalidate；仅创建 `skills/` 文件夹不保证热加载。当前通用文件/执行工具仍受限，技能文档不能赋予执行权限。
- 当前 `dsh-schedule/README.zh.md` 明确投递依赖 Host Web Session controller 和 session flush，不支持单独 headless/SDK 组合。QQ 的 SessionManager 自行创建/恢复 agent，兼容性需要 spike。
- 推荐先用独立 reflection worker，任务键 `(self_id, scope, period, job_type)` 幂等，内部 journal 与对外发送分离；DSH schedule 验证通过后再替换调度器。
- MCP 后续按 server 独立凭据、工具 allowlist 与审批接入；[官方安全文档](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) 特别强调 token passthrough、SSRF 与信任边界。

本地包参考位于 `/home/example/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/` 的 `dsh-system-prompt`、`dsh-skill`、`dsh-schedule`。

## 5. 推荐开发顺序与交付门槛

| 阶段 | 具体交付 | 验收门槛 |
|---|---|---|
| P0-A 基线与边界 | 修正文档版本、明确删除/reset/记录范围；统一锁入口；owner 身份；QQ 发送能力验证；冻结回归样本 | 118 单测和类型检查保持通过；群端文本/图片/引用/命令/回声基线人工确认 |
| P0-B 可靠 Ledger | 事件协议、持久交接、Postgres migrations、媒体 blob、出站回执、tool correlation、导出 CLI | 重复投递不重记；命令/未发言/队列溢出可追踪；DB 故障与杀进程后可回放；24h 覆盖对账 |
| P0-C 记忆闭环 | remember/revise/forget/search/recent、证据、revision、候选提取 worker、中文检索、上下文预算、删除与暂停 CLI | 50–100 条样本评估；新会话可召回；跨群拒绝；删除及 worker 重试不复活；修订冲突稳定返回 |
| P0-D 自我与关系 | 单一 self、群/人关系卡、锚点/叙事分离、版本化、漂移检测 | 3 session 与跨天人工体验；不被一条群消息改核心身份；角色更换不丢合法记忆 |
| P1-A Attention | 引用/图片感知；speak/observe/ignore；记忆候选独立；失败降级；成本、队列与限额 | 先 shadow 只记录决策，继续 replyAll；回放评估后单群可选开启，随时切回 |
| P1-B 反思 | daily/weekly journal、open threads、任务租约、幂等、内部预算 | 连续 7 天任务可追踪；崩溃可续跑；对外发言只走已验证的平台能力 |
| P1-C Skills/MCP | preset、能力注册表、provider invalidate、1 个只读 MCP；容器隔离后再扩展 | 新能力不改 memory domain；未知/越权工具拒绝；凭据不跨 server 泄漏 |
| P2 升级/多平台 | builder、测试/staging/审批/回滚，第二平台 | 独立立项；生产 QQ agent 不直接改自身代码 |

管理最小闭环应提前随 Ledger/Memory 交付：health、导出、暂停发言、暂停记忆写入、删除。可视化后台以后再做。备份从第一次落库开始，先完成全量备份和恢复演练，再完善 WAL/PITR。

2026-10-20 更新：已接入第二个指定群，并完成保留 QQ 票据的容器重建自动登录验证；详见 [登录恢复](CHANNEL-RECOVERY.md)。P0-C 已交付 MemoryStore 与 DSH 工具、证据/revision、词法召回、逻辑遗忘、范围删除和暂停写入；schema 4 又加入统一 person_id、跨群个人事实与普通自述自动保存，真实跨群召回已人工确认，见 [人物记忆](PERSON-MEMORY.md)。异步多轮整理、真实历史评估、向量/近似去重、关系/self、衰减与回滚尚未完成，不将此片算作 P0-C 全部验收。自主整理无需“记住”指令，网页搜索可作为后续单独只读工具接入。

不沿用 PRD 的周数作为承诺。当前缺少群流量、token 使用、平台资格、embedding 选择和可投入时间数据，应按阶段验收推进，再用首轮实测估算工期。

### 首批可执行变更单

1. 文档与契约：修正 SDK 版本；统一事件身份、作用域、删除和发言能力；明确尚未确认事项。
2. 运行基线：service 走锁入口、管理身份、发送期限建模、guard 能力检查；补故障场景验证。
3. 数据基础：独立 qqbot-life 包、迁移、DB compose 模板、备份恢复说明、脱敏合成事件样本。
4. Ledger 纵向切片：一条文本从接收到平台发送回执全链路可查，再扩展媒体、引用、命令、工具。
5. Memory 纵向切片：一句偏好 → 有证据记忆 → `/new` 后正确召回 → 修改有版本 → 删除后全部召回路径失效。

上层目录当前没有 Git 仓库，`dsh-qqbot` 是独立仓库。正式提交前需明确外层 Life Core 与 docs 的版本管理归属，避免核心开发成果游离于可审查提交之外。

## 6. 待 owner 明确的产品参数

这些决定不阻塞本地合成数据开发，但在真实群聊持久记录、正式预算或平台上线前需要明确。

- 哪些群允许记录，如何告知和退出；原文/媒体/备份保留期。
- 每日成本上限和模型服务可用范围；embedding 本地或远程。
- owner 身份列表、谁能 reset 群会话、谁能审批 persona 核心变更。
- 一个人跨群的关系信息是否允许复用；默认按群隔离，跨平台身份绑定需显式确认。
- 自我可自动更新的字段：建议 narrative/interests/current_focus 自动版本化，身份/价值观/权限锚点走受控 proposal。
- QQ 主动发送是否具有特殊资格；未确认时关闭该能力，保留内部反思。

## 7. 验收指标建议

- 事件：接收唯一数、成功持久化数、spool 积压、拒绝/重复/回声/丢弃数、outbound confirmed/failed/unknown。
- 记忆：recall@k、正确率、证据一致率、冲突率；跨群泄漏和删除后召回在固定测试集必须为零。
- 性能：检索 p95 <1.5s；首字延迟拆成接入、排队、检索、模型、发送，避免用整体均值掩盖积压。
- 体验：直接呼叫漏答率、无关插话率、连续发言数、人工口吻反馈；先采集基线再确定正式阈值。
- 运维：DB 故障回放、媒体过期、磁盘满、强杀重启、备份恢复、暂停恢复均有真实演练记录。

本轮结论的边界：已阅读 PRD/说明/关键源码，核验依赖与配置并运行单测和类型检查；未验证 QQ 端到端、主动消息应用资格、容器部署、数据库或真实跨天记忆。

## 8. 补充调研：普通 QQ 账号适配器与后台主动触发

核验日期：2026-10-20。结论：NapCatQQ + OneBot 11 值得作为普通账号通道的优先原型；它能让后台任务调用独立发送 API，但不会自动提供 Life Core，也不能保证账号永不掉线或发送始终成功。Lagrange 需要区分版本，不宜直接按旧教程选择。

### 8.1 三个概念与选择

| 组件 | 当前能力与状态 | 对本项目的意义 |
|---|---|---|
| NapCatQQ | 基于 NTQQ 运行环境，登录普通 QQ 账号，对外提供 OneBot 11 等接口；官方 release API 本轮返回 2026-10-12 的 v4.18.38 | 首选普通账号通道原型，已有群聊、私聊、图片和引用相关接口 |
| Lagrange.Core | C# NTQQ 协议实现；当前主线 README 标明 V2，服务端接口为 Lagrange.Milky | 可以考虑，但需要 Milky adapter，不能假定主线直接兼容 OneBot 11 |
| Lagrange.OneBot | 位于已日落 V1 路线；V1 README 还含中央签名服务停用提示 | 新项目不默认采用旧发布包，登录/签名与维护状态需单独验证 |
| OneBot 11 | 应用与协议端之间的事件/API 规范 | 它本身不登录 QQ，也不提供模型或记忆；`send_group_msg` 只需 group_id/message，不要求触发消息 id |

来源：[NapCat 仓库](https://github.com/NapNeko/NapCatQQ)、[发布记录](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.38)、[接口兼容表](https://napcat.napneko.icu/develop/)、[安装说明](https://napneko.github.io/guide/boot/Shell)、[Lagrange 当前主线](https://github.com/LagrangeDev/Lagrange.Core)、[V1 说明](https://github.com/LagrangeDev/Lagrange.Core/blob/v1/README.md)、[OneBot 11 发送规范](https://github.com/botuniverse/onebot-11/blob/master/api/public.md#send_group_msg-发送群消息)。

NapCat 的 LICENSE 是带使用、修改、分发和商业用途限制的自定义许可。它不能简单视作 MIT 类许可；自托管运行与复制其代码进本项目须分别评估。优先通过公开协议独立编写适配器，实际使用前核对所选版本条款。[许可原文](https://github.com/NapNeko/NapCatQQ/blob/main/LICENSE)

### 8.2 当前官方 bot 也能由后台任务触发

应把两个维度分开：

- 本地触发：cron/worker/定时回调唤醒 agent，生成结果并调用发送函数，技术上可以实现。
- 平台投递资格：官方接口发送时是否携带有效、未过期、未超额的 msg_id/event_id；没有上下文时是否具有主动发送资格。

所以“不能任意主动推送”不等于“后台不能发消息”。例如，用户在群里发起任务后，任务在被动窗口内完成，可由后台延后发送；反思任务也可生成结果后等待下一个允许的发送时机。但群里沉默很久后，定时回调无法凭空生成平台认可的新消息 ID，回调本身不会刷新窗口。

官方文档源码当前列群聊被动窗口为 5 分钟、单聊 60 分钟、每消息最多回复 5 次；特殊事件窗口与全量群消息是否都具备回复资格，应按事件类型实测。不能把反复使用旧消息 ID 当成永久发送授权。[腾讯官方发送文档](https://raw.githubusercontent.com/tencent-connect/bot-docs/main/docs/develop/api-v2/server-inter/message/send-receive/send.md)

本地已有一部分机制：

- `transport/msgid-cache.ts` 缓存最近消息和互动事件；群缓存窗口 5 分钟、私聊保守使用 30 分钟。
- `transport/reply-target.ts` 依次尝试显式消息 ID、同目标缓存 ID，最后去掉 ID 走主动发送。
- `gateway/bootstrap.ts` 的发送适配器已使用这条解析链，但没有专门的 Life scheduler/持久任务投递服务。

补充第 3.1 节：不是所有回复统一按 1 小时过期——缓存层已有按 scope 的 TTL；问题是显式 target.msgId 仍由 ReplyLimiter 的“首次发送记录起 1 小时”判定，并可能优先于新鲜缓存 ID。还需统一原事件时间、作用域、剩余回复次数和发送结果，避免误用过期上下文。

注意缓存目前在 post-middleware message handler 中写入；以后 attention 静默、命令截获、长队列时会影响上下文收集和时效。建议在 access/去重后安全记录原始消息时间，再由发送策略选择合法上下文，保持回复关联并遵守群预算。

### 8.3 接入方式与复用范围

```text
QQ 官方 bot ── official adapter ─┐
                               ├→ 统一 ChannelEvent → Ledger / Life Core / DSH
普通 QQ 小号 → NapCat → OneBot ─┘                         ↑
                                               scheduler / worker
                                                        ↓
                                      OutboundIntent → 投递策略 → adapter
```

两种通道都表达 send intent，但发送能力不同：官方通道需要有效回复上下文；普通账号通道调用独立发送 action，仍受账号在线、群权限、客户端/协议兼容和服务端风控影响。

保持 DSH、Life DB、persona、记忆、反思与预算不变；新增 `dsh-onebot`/`channel-onebot` 适配器。当前 `dsh-qqbot` 使用腾讯 SDK 中间件和发送类型，不能只替换 appId 或 API baseUrl 就完成迁移。会话与生命周期设计可参考，传输层、媒体/引用解析和官方交互卡片需重新适配。OneBot 侧审批/提问先用带编号的文本交互。

身份与事件以 `transport + account_id + scope + peer_id` 命名空间隔离。官方 openid 和普通 QQ 号不自动等同；同一群双入口不同时开启自动回复，以免互相触发。过滤登录账号自身事件，ID 去重包含账号和来源。

独立小号只隔离账号影响范围，不消除登录验证、掉线、封禁或客户端更新风险。PoC 使用独立数据目录/容器；OneBot API 只在 loopback/私网开放并校验 token，模型仅获得本项目需要的收发能力，不能因为协议支持就开放任意群管理或账号凭据 API。

检索还发现 [dsh-napcatqq-remote](https://github.com/riki-forsure/dsh-napcatqq-remote)，其定位是 DSH QQ 远程操控而非本 PRD 的群体生命系统，可以参考桥接方式，不能未经代码和权限审查就直接作为群聊生产配置。

### 8.4 推荐验证顺序

1. 保留现有官方通道；先定义后台 trigger、持久 OutboundIntent 和按通道判断的 delivery capability。
2. 官方通道验证任务延后回复、有效窗口、额度、过期失败与 unknown 状态；不承诺无上下文定时群发。
3. 使用独立测试小号和测试群验证 NapCat：收到群/私聊事件、图片/引用、API 发送回执与接收端实际可见性。
4. 让群保持安静，超过官方被动窗口后，由后台定时任务通过 OneBot 发送；这是本次选型最关键的对照验收。
5. 验证掉线重连、重启登录、重复事件、自身回声、限速和 24h 稳定性，再决定主用或保留双通道。

以上为资料与代码分析；本轮未安装 NapCat/Lagrange、未登录账号、未创建实际定时任务、未向 QQ 发送消息。

### 8.5 后续实施与实测结果（2026-10-20）

已在 `/ABSOLUTE/WORKSPACE` 独立拉取源码并部署 NapCat 4.18.38，小号完成登录。仅在博士授权的“测试群”群验证：HTTP/WebSocket token 鉴权、文字事件接收、普通发送，以及连续静默超过 330 秒后由后台进程独立发送。两条消息均有 API 成功回执及博士的接收端可见确认。

因此，本项目采用 NapCat 普通账号通道进行后续开发已有初步运行证据；这个结果不改变官方 bot API 的投递约束。当前未接入 DSH/Life Core，不会自动回复。图片读取、引用、断线恢复和长时间稳定性仍需后续验证。详情见 `/ABSOLUTE/WORKSPACE/docs/ONEBOT-VALIDATION.md`。

### 8.6 DSH OneBot 适配器首版（2026-10-20 后续）

已在独立源码仓库 `/ABSOLUTE/WORKSPACE/dsh-onebot` 开发并部署插件，使用独立 DSH_HOME、HOME、媒体目录和测试群白名单。已实现群聊/私聊分开授权、会话恢复、串行队列、去重、预算、引用/图片处理和仅允许媒体目录 read_image 的工具边界。当前只开放“测试群”群，私聊关闭，原官方 bot 未改动。

17 项测试通过；真实图片引用样本已完成下载、read_image、模型输出及 QQ 发送，博士通过飞书确认描述正确；另已通过 live WebSocket 文字及直接图片消息闭环。18:19 的直接图片样本已获 API 成功及博士接收端可见确认。账号掉线和长时间稳定性仍需独立验收。Life Core 与全量 Ledger 尚未实现，不能将 session 恢复或适配器去重当作它们已经交付。

按博士指令，cc-connect 临时停止并保留恢复方式，测试请求和回复由本开发通过飞书 bot API 收发。完整说明见 `/ABSOLUTE/WORKSPACE/dsh-onebot/README.md`。

### 8.7 Life Core 第一阶段与 Git 管理（2026-10-20）

已在 `/ABSOLUTE/WORKSPACE` 建立统一 Git 项目，独立 `life-core` 包负责 PostgreSQL 追加事件账本、事务入站任务、带心跳租约的串行领取、Outbox、媒体关联、持久预算与管理 API；`dsh-onebot` 仅负责通道和 DSH 编排。敏感运行目录与上游源码不入库，尚未发布到远程。

独立 PostgreSQL 16.14 已部署在 loopback 15432，没有复用 Butler 数据库。实际群聊文字、图片、引用图片均已入账并获博士接收端确认；真实停库回放、适配器 SIGKILL 自动恢复、非空数据库备份恢复及独立 PostgreSQL 回归已执行。会话恢复测试发现模型曾倒置图片顺序，账本和 DSH 日志顺序正确，后续又自行纠正；因此另补基于事件的近期图片索引与受限原图复核，不将模型自我纠正当作可靠性证明。

后续人工测试按博士最新指令直接在本 Codex 聊天协作，不再使用飞书。cc-connect 继续暂停。阶段能力、恢复语义、删除与备份边界及当前验收详见 `/ABSOLUTE/WORKSPACE/docs/LIFE-CORE-FOUNDATION.md`。长期记忆、关系画像、Self Model、反思和主动发言调度仍未实现。

8.7 后续验收：近期图片索引修复已完成真实群聊回归，回复前重新 read_image，博士确认上一张为马克杯。独立新 API key 已按博士要求写入私有文件并切换运行进程，与原 bot 分离；新增 model.usage 和本地 token 汇总命令，不估算金额账单。完整检查 43 项通过，具体结果见上述基础层文档。

### 8.8 后台增量整理（2026-10-21）

schema 5 已增加独立 consolidation worker：按真实用户和群的游标读取普通聊天，受限 JSON 提取，复用 MemoryStore 的来源/权限、候选、冲突和精确去重；决策先持久化再执行，租约重试与跨重启预算独立于回复队列。修订/遗忘推进隐私 epoch 与来源下限，旧整理任务不得复活已撤销资料。迁移不批量提取旧群聊。

141 项检查及一次真实 API 隔离验收通过，包含中断后不重复调用、跨群人物检索、其他用户隔离、非空 schema 5 备份恢复。配置、运行状态和真实群聊验收边界见 [后台记忆整理](MEMORY-CONSOLIDATION.md)。这不是完整关系/self/反思，也没有实现网页搜索或主动发言。
