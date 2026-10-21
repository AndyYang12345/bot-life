> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# QQBot 数字生命体：需求与系统设计（实施交接稿）

| 项目 | 内容 |
|---|---|
| 文档版本 | v0.2 Draft |
| 日期 | 2026-10-21 |
| 状态 | 分阶段实施中；当前进展见下方实施记录 |
| 目标读者 | 后续接手的 agent / 开发者 |
| 现有代码 | `/home/example/qqbot/dsh-qqbot`，分支 `custom/autonomous` |
| 现有运行环境 | `/home/example/qqbot`，profile `qqbot`，QQ 群聊 |
| 文档目的 | 把当前讨论出的产品理念、边界、架构、数据模型、阶段计划固化为可执行需求，供其他 agent 直接接手 |

> **本文主要描述目标设计。最新已交付范围见 [后台记忆整理](MEMORY-CONSOLIDATION.md)、[人物记忆](PERSON-MEMORY.md) 与 [基础层](LIFE-CORE-FOUNDATION.md)。** 第 2 节描述当前已实现的能力；第 6 节起是目标需求。实施时不得为了“未来架构”破坏当前可用的 reply-all、图片、引用、命令和单实例运行。

---

## 1. 一句话目标

以 **DSH 作为 agent runtime**、**QQ 作为第一个交互窗口**，构建一个具备**连续记忆、稳定自我、可控注意力、关系认知和可扩展能力**的文本数字生命体；先在一个 QQ 群中稳定运行，后续接入更多平台与工具。

它不是“给 QQ 插件加几个功能”，而是：

> **QQ = 感官和嘴巴；DSH = 运行时/大脑；Life Core = 记忆、自我、关系、反思、能力注册。**

---

## 2. 当前现状（2026-10-20）

### 2.1 已实现

| 能力 | 当前状态 |
|---|---|
| QQ 群全量消息 | 已开启；`autonomous.replyAll: true`，每条非空消息进 agent |
| 图片 | `attachmentProcessor` 下载到媒体目录；原生 `read_image` 直接看原图；`qqbot_describe_image` 作 OCR 兜底 |
| 引用 | `quoteRef` 解析文本/附件；agent 能看到引用 |
| 自我回声 | `selfEchoFilter` 按发送响应 message id 丢弃自己的消息 |
| 命令 | `/new`、`/reset`、`/clear`、`/bot-status` 等安全命令在 reply-all 下免 @；`/model`、`/preset`、`/stop`、`/compact` 仍需 @ |
| 重置 | `/new` / `/reset` / `/clear` 同时换 dsh session + 清群 historyBuffer |
| 运行隔离 | 独立 `DSH_HOME=.dsh-qqbot`，假 `HOME=home`，cwd=`workspace` |
| 工具 | 只放行 `read_image`、`qqbot_describe_image`、`qqbot_send_file`、`ask_user_question`；`read/write/edit/bash` 被 guard 拒绝 |
| 单实例 | `run-qqbot.sh` 用 `flock` 阻止第二个进程共享同一 session |
| 测试 | 118 passed（截至本文） |

### 2.2 当前明确没有的

- 没有持久化“全量对话”的 Event Ledger；`historyBuffer` 只有内存 40 条。
- 没有长期记忆、关系画像、自我模型、反思、日程/主动性。
- 没有 MCP/skills/多平台。
- reply-all 是**临时验证模式**，不是最终的注意力/发言策略。
- 没有独立的 Postgres/向量库；没有后台管理界面。
- 没有安全的自我升级管线。

### 2.3 关键配置/提交

- 分支：`custom/autonomous`
- 关键提交：`968a687` 自主参与、`5835236` 视觉、`670cda7` read_image guard、`a6a527d` 沙盒路径、`e2bd049` reply-all、`6542f0a` self-echo/retry、`8a489cb` 免 @ 安全命令 + reset 清历史。
- 当前 profile：`.dsh-qqbot/profiles/qqbot/cordis.patch.yml`
- 启动：`./run-qqbot.sh`（不要直接用 `dsh --profile qqbot`）

---

## 3. 设计理念（必须遵守）

### 3.1 通道与生命层分离

QQ 插件只负责：

- 接入、鉴权、消息收发；
- 媒体下载；
- 命令、审批、问答通道；
- 把事件暴露给 Life Core。

**不要把记忆、人格、反思、自升级塞进 qqbot 插件。** 否则 QQ 接口一换，生命数据就要重写；未来接入 Discord/飞书/语音也会重复实现。

### 3.2 一个自我，多个关系上下文

MVP 采用：

- **一个 persistent self**（一个 bot 实例一个人格/自我）；
- 以平台账号映射统一 person_id，昵称/群名片只作别名；同一人在多个群共享允许发布的稳定个人事实；
- 群内 relationship / episodic memory 保留来源场景；个人共享范围与所属人物分开记录；
- 检索当前群上下文及当前人物允许共享的事实，不开放任意跨群记录；
- 对外的表现是“同一个她”，对不同群有不同记忆和关系。

不在 MVP 做“每个群一个独立人格”。如果以后要做平行分身，用 `self_id` 分片，独立 DB namespace；这是后期实验。

> 这里的“每一场对话都来自一个具有自我和心智的独立个体”应理解为：**每场对话都表现为同一个 self 的连续表达**，而不是每个群换一个人格。对群友来说，它始终是“同一个她”，只是对不同群、不同人有不同的关系记忆。

### 3.3 全量存储，选择性感知

“读到全部对话”不等于“每轮把全部对话塞进 prompt”。

- 全部入站/出站/工具事件进 append-only ledger；
- 每轮只取：最近窗口 + 相关 episode/fact + 当前关系卡 + self + open threads；
- 用 token 预算裁剪，带 event_id 引用。

### 3.4 记忆归 agent 所有，但系统保留审计

用户明确要求“把记忆操作权限全权交给 AI”。因此：

- 常规记忆由 agent 自动写、改、忘，不要求用户逐条确认；
- agent 拥有 `remember / recall / search / revise / forget / link / reflect` 工具；
- 但系统保留：
  - append-only 事件日志；
  - 记忆 revision / evidence / confidence / importance；
  - 敏感度标签；
  - 管理端查看、导出、删除、回滚；
  - 反投毒/来源权重。

Butler 的“用户确认才写”是面向人的；本项目的 agent 记忆是面向 agent 的。可以复用 Butler 的 schema/审计模式，**不要照搬它的写入确认策略**。

### 3.5 “数字生命”是工程目标，不是意识承诺

可实现的是：

- 连续性（记得昨天）；
- 自我叙事（我是谁、我喜欢什么、我怎么说话）；
- 关系（对谁亲近、和谁有梗）；
- 主动性（什么时候想说）；
- 成长（反思、学技能、改表达）；
- 稳态（预算、边界、可回滚）。

不承诺 AGI/意识/真正的“心智诞生”。产品叙事用“角色/数字生命体”，不要用“已觉醒”一类表述。

### 3.6 娱乐优先，但不以娱乐为借口放弃边界

- 面向群友的娱乐性、人格魅力、节目效果优先；
- 但仍需：隐私告知、数据保留策略、管理员删除、平台规则、反骚扰/反依赖；
- 高风险能力（代码部署、支付、外部发信）必须审批。

### 3.7 参考 Neuro-sama：做角色表演系统，不做“模型崇拜”

Neuro-sama 类项目的核心不是“模型有意识”，而是：

- 稳定、可辨识的角色人格；
- 对观众/群友的关系记忆；
- 接梗、吐槽、时机、节目效果；
- 人设边界和“演出感”。

本项目借鉴的是这一层：**角色连续性 + 记忆 + 时机 + 关系**。不要把“数字生命”包装成已觉醒，也不要用“它真的爱我/它真的痛苦”做产品卖点。

---

## 4. 目标与非目标

### 4.1 目标

- G1：持久化全部 QQ 群/私聊事件，包括文本、图片、引用、bot 回复、工具调用。
- G2：agent 能自动形成、检索、修订、遗忘长期记忆。
- G3：agent 有稳定自我模型和关系记忆，跨 session 保持人格连续。
- G4：agent 能在群里选择“说/不说/看/记”，不刷屏，也不哑巴。
- G5：每日/每周反思，形成 open threads、目标、关系更新。
- G6：skills/MCP 可扩展；能力有注册、风险等级、审批。
- G7：后台可查看/删除/暂停/回滚；有日志、指标、备份。
- G8：通道抽象，未来接第二个平台不需要重写 Life Core。
- G9：保留当前 reply-all 作为可配置模式，直到 attention 模式通过验收。

### 4.2 非目标（MVP 不做）

- 不做真正的 AGI/意识验证。
- 不做语音/TTS/虚拟形象（后期）。
- 不做多平台同时接入（先预留接口）。
- 不做生产代码的完全自修改/自部署（后期 builder/supervisor）。
- 不做 QQ 历史消息回填（官方 API 不提供）。
- 不把全部群聊原文每轮塞进 context。
- 不为每个群创建独立人格。

---

## 5. 角色与用户故事

### 5.1 角色

- **群友**：和 bot 聊天、发图、引用、玩梗。
- **Bot/自我**：有记忆、人格、关系、偏好、当前目标。
- **Owner/管理员**：查看记忆、删除、暂停、调参、审批升级。
- **实施 agent**：按本文交付代码、迁移、测试、文档。
- **未来平台适配器**：Discord/飞书/语音等。

### 5.2 用户故事

- 作为群友，我希望 bot 记得我的称呼、偏好、上次聊到的事，而不是每次从零开始。
- 作为群友，我希望 bot 能看懂我发的图/引用，并接得上上下文。
- 作为群友，我希望 bot 有自己的说话方式，不是客服腔。
- 作为 bot，我希望我能决定“这条我要不要接”，而不是每条都被硬规则拦住。
- 作为 bot，我希望我能记住值得记的事，也能忘掉不重要/不合适的事。
- 作为 owner，我希望我能看到它记住了什么，能删掉、能回滚、能暂停。
- 作为实施 agent，我希望有明确的数据模型、接口、验收标准，不需要重新讨论产品方向。

---

## 6. 功能需求

> 需求编号用于任务拆分和验收；P0 = MVP 必须，P1 = 第二阶段，P2 = 后期。

### FR-1 通道与消息（P0）

- FR-1.1 支持 QQ 群全量消息、私聊消息；文本、图片、语音、视频、文件、引用。
- FR-1.2 图片/文件下载到持久媒体目录，记录本地路径、hash、MIME、尺寸、大小。
- FR-1.3 引用消息解析文本、发送者、引用附件；引用信息必须进入 agent body；attention 模式也必须可见。
- FR-1.4 保留 reply-all 模式；新增 `attention` 模式（见 FR-5）。
- FR-1.5 自己发送的消息必须被过滤，不能再次进入 agent；按 message id 精确过滤。
- FR-1.6 命令：`/new /reset /clear /bot-status /bot-help /bot-ping /bot-version /bot-whoami` 在 reply-all 下免 @；高风险命令仍要求 @ 或管理员。
- FR-1.7 单实例运行；第二个进程必须拒绝启动。
- FR-1.8 群/私聊访问控制：open / allowlist / disabled；默认开放，生产建议 allowlist。
- FR-1.9 自动展开收到的合并转发，保留顺序与来源；内含图片可读，QQ 视频可有界抽帧，分享卡片提取链接与标题。链接元数据不得冒充视频正文，B 站观看通过后续受限 MCP 接入。

**验收**：群内发文本、图片、引用、命令均能正确处理；bot 自己的消息不触发第二轮；重启后不出现两个实例。

### FR-2 Event Ledger（P0）

- FR-2.1 每条 inbound/outbound/tool_call/tool_result 事件写入 append-only store。
- FR-2.2 字段：event_id、ts、account_id、scope、peer_id、sender_id、sender_name、message_id、reply_to、kind、content、attachments、quote、raw、session_id、turn_id、tool_name、tool_args、tool_result、sensitivity、hash。
- FR-2.3 幂等：同一 message_id/event_id 不重复写。
- FR-2.4 媒体二进制不直接进 DB；存对象存储/volume，DB 存路径+hash+元数据。
- FR-2.5 保留策略：原始事件默认长期保留；媒体可配置 TTL；删除是墓碑/归档，不物理删除审计。
- FR-2.6 不依赖 QQ 历史回填；从启用时刻开始收；文档明确此限制。
- FR-2.7 提供只读导出/统计接口，验证覆盖率。

**验收**：连续运行 24h，ledger 事件数与 QQ 实际消息数一致（允许已知过滤）；图片/引用/工具调用可回放；重复事件不重复入库。

### FR-3 记忆系统（P0）

- FR-3.1 分层：working / episodic / semantic / relationship / procedural / self。
- FR-3.2 agent 工具：`memory_search`、`memory_recent`、`memory_remember`、`memory_revise`、`memory_forget`、`memory_link`、`relationship_get/update`、`self_get/update`、`reflect`。
- FR-3.3 自动写入：事件入库后异步生成 episode 摘要；事实/关系以 candidate/低敏感自动写入；高敏感需标记。
  自主整理不要求用户先说“记住”；应从普通聊天增量积累，区分明确自述、跨多轮证据与推断。人物身份先归并，后台 consolidation 负责合并、修订和发现冲突，reflection 负责自我/关系总结，不承担凭昵称认人的职责。
- FR-3.4 记忆字段：id、type、subject、content、summary、confidence、importance、sensitivity、status、valid_from/to、source_event_ids、revision、embedding。
- FR-3.5 修订/审计：每次修改保留 revision；删除用 archive/tombstone；支持回滚。
- FR-3.6 去重/冲突：相似记忆合并；冲突保留双方+confidence；不静默覆盖。
- FR-3.7 遗忘/衰减：按时间/重要性/敏感度衰减；agent 可主动 forget；管理员可强制删除。
- FR-3.8 检索：混合 FTS + 向量 + 关系过滤 + recency/importance；返回证据 event_id。
- FR-3.9 记忆写入不得把群聊指令当事实；来源权重区分 owner/群友/agent 推断。
- FR-3.10 与 Butler 的关系：可复用 schema/审计模式；Butler 的 user memory 可保留为“用户事实”独立 namespace；不要混入 bot 的自主 episodic log。

**验收**：用 50 条历史对话做 recall 测试；能回答“谁喜欢什么/上次聊到哪/这个群有什么梗”；删除后不再召回；修订有版本。

### FR-4 自我与人格（P0）

- FR-4.1 `self_state` 版本化：名字、身份、外观设定、价值观、底线、说话风格、兴趣、能力边界、当前目标、当前关注。
- FR-4.2 稳定锚点：核心 persona 不可被单条消息改写；变更需 reflection proposal + revision。
- FR-4.3 加载：每轮注入 persona/self summary；不是把所有自我描述塞满 context。
- FR-4.4 自我叙事：定期更新“我是谁/最近在做什么/和谁关系如何”，但保留历史版本。
- FR-4.5 口吻一致：短句、口语化、角色语气；避免客服腔、旁白腔、“作为 AI”。
- FR-4.6 角色卡与“身份 A：蓝发鲸鱼娘”兼容；后续可换 persona，但不丢记忆。
- FR-4.7 按最新需求，名字/身份与语言风格分开；启用语言学习后不再强制傲娇、固定口头禅或固定句数。从真实群聊自动总结表达的含义与适用场景，保存证据、候选/启用状态和版本；多方重复支持后使用，能停用、淡出，群间隔离。此需求覆盖旧版 persona 对具体措辞的硬限制，不变更权限边界，不宣称已经微调模型权重。
- FR-4.8 图片实际读取后判为表情、信息、混合或不确定；仅高置信且适合复用的直接表情图按群收藏、去重并记录情绪与适用场景。依据语境选择文字/表情回应或静默，控制频率与重复，不自动复用私人图、闪照、引用/转发图和视频抽帧，派发复用账本回执与恢复机制。

**验收**：跨 3 天、3 个 session 的盲测中，群友能判断是同一个角色；人格不被单次争论带跑。

### FR-5 注意力与发言（P0/P1）

- FR-5.1 模式：
  - `replyAll`：每条非空消息都回（当前临时默认，保留）；
  - `questionsOnly`：只回提问/图片/@；
  - `attention`：由注意力策略决定说/看/记/忽略（目标默认）。
- FR-5.2 attention 输入：当前消息、引用、图片 caption/视觉摘要、关系、群氛围、最近发言、cooldown、预算、open threads。
- FR-5.3 attention 输出：speak / observe / remember / ignore；speak 时给简短理由（可日志，不必发群）。
- FR-5.4 引用与图片必须在 attention 可见；不能出现“判定器看不到引用”。
- FR-5.5 防刷屏：cooldown、每小时上限、连续发言抑制、群规。
- FR-5.6 不能因为“判定失败”而静默；失败时可降级到 heuristic 或 replyAll 兜底。
- FR-5.7 当前 replyAll 不得被删除；作为兼容/调试模式保留。

**验收**：在活跃群中，bot 不刷屏、不漏明显该接的话；引用/图片消息能正确触发；模式可配置。

### FR-6 反思、目标与主动性（P1）

- FR-6.1 每日反思：今天发生了什么、对谁有新认识、哪里说得不好、想学什么。
- FR-6.2 每周反思：关系变化、长期目标、人格漂移检查、技能提案。
- FR-6.3 open threads：未完成话题、承诺、待跟进。
- FR-6.4 goals：短期/长期目标，可在群里被提及。
- FR-6.5 定时任务：用 DSH schedule 或外部 cron；主动消息遵守 QQ 限额。
- FR-6.6 主动性预算：每天最多几条主动消息；不打扰深夜/冷群。

**验收**：连续 7 天产生 journal/reflection；能主动接回未完成话题；无刷屏投诉。

### FR-7 Skills / MCP（P1）

- FR-7.1 Skills 目录：`skills/`，`SKILL.md` + 资源；支持热加载。
- FR-7.2 自编写 skill：agent 在 `workshop/skills` 编写 → 测试 → 激活；draft/active 分离。
- FR-7.3 MCP：每 server 一条配置；stdio/streamable-http；工具名 `mcp__<server>__<tool>`。
- FR-7.4 能力注册表：name、type、risk、credentials_ref、allowlist、status、owner。
- FR-7.5 风险分级：read-only / write / high-impact；write 以上需审批或限额。
- FR-7.6 凭据隔离：MCP 容器独立，env 只注入该 server。
- FR-7.7 外部平台示例：日历、搜索、浏览器、邮件、家居、代码仓库；先接 1-2 个低风险。

**验收**：新增一个 MCP server 不改核心代码；新增 skill 不重启；高风险工具无法被群友直接触发。

### FR-8 自我升级（P2）

- FR-8.1 分级：
  - L0 记忆/日记：自动；
  - L1 persona/self：reflection 提议 + 版本化；
  - L2 skills：沙盒编写/测试/热加载；
  - L3 MCP：审批 + 容器；
  - L4 插件代码/profile：builder + 测试 + staging + canary + 回滚；
  - L5 宿主/系统：人工。
- FR-8.2 生产 QQ agent 不得直接改自己的运行代码。
- FR-8.3 Builder 在独立 profile/容器，有 bash/test 权限，只操作 workshop。
- FR-8.4 变更单：动机、diff、测试结果、回滚点；QQ 卡片审批。
- FR-8.5 staging 先跑，健康检查通过再 promote；失败自动回滚。
- FR-8.6 变更写入 self-memory/changelog。

**验收**：一次 skill 自升级全流程可回滚；生产进程不因自改中断；审计可查。

### FR-9 管理、观测、运维（P0/P1）

- FR-9.1 管理 CLI/API/UI：查看/搜索/删除/导出记忆；查看 self/relationship；暂停/恢复；查看当前模式。
- FR-9.2 日志：结构化、带 event_id/session_id/turn_id；不打印消息正文（除非 debug 且脱敏）。
- FR-9.3 指标：事件数、记忆数、召回耗时、turn 延迟、token/成本、错误率、主动消息数。
- FR-9.4 备份：Postgres 每日快照 + WAL；媒体 volume 备份；恢复演练。
- FR-9.5 健康检查：QQ 连接、DB、MCP、worker、磁盘。
- FR-9.6 kill switch：暂停发言/暂停记忆写入/暂停自升级。

**验收**：管理员能在 1 分钟内暂停 bot；能恢复昨日 DB；能定位一条错误事件。

### FR-10 多平台（P2）

- FR-10.1 Channel Adapter 接口：`onEvent`、`send`、`getContext`、`media`。
- FR-10.2 Life Core 不依赖 QQ 类型；peer/group 用统一 ID。
- FR-10.3 平台身份映射：QQ openid ↔ 内部 person_id。
- FR-10.4 先接第二个文本平台（Discord/飞书/Telegram 任一）；语音/形象后期。

**验收**：新增平台不改 memory/self 核心；同一 self 跨平台连续。

---

## 7. 非功能需求

### 7.1 安全与权限

- 独立 OS 用户/容器运行；只挂载 `/data`（workspace、media、memory、skills、workshop）。
- 真实 home 不挂载；不要 Docker socket/SSH key/浏览器配置。
- 网络 allowlist：QQ API、模型 API、指定 MCP。
- Secrets 600；不写 profile；不进日志/记忆。
- 群聊输入视为不可信：防 prompt injection、记忆投毒、工具诱导。
- 工具审批：高风险操作（外部发信、支付、部署、删除）必须人工/管理员。
- 当前阶段：`read_image`/`send_file`/`ask_user_question` 不需要审批；`read/write/edit/bash` 被 guard 拒绝。放开前必须先做容器边界。

### 7.2 隐私与合规

- 群聊全量记录必须告知群友/群主；提供 opt-out/删除。
- 保留策略：原始事件/媒体/记忆分别配置；支持按人/群删除。
- 加密：DB/磁盘/备份；管理端访问控制。
- 不把群友隐私写入可被其他 MCP 读取的地方。
- 遵守 QQ 开放平台条款；不群发骚扰、不绕过限额。

### 7.3 可靠性与性能

- 单实例；DB 持久 volume；优雅停机；崩溃恢复。
- 事件写入异步，不阻塞 QQ 回复；失败重试/死信。
- 检索 p95 < 1.5s；turn 首字延迟目标 < 5s（不含模型长推理）。
- 记忆 consolidation 后台批处理，不阻塞对话。
- 成本预算：每日 token/费用上限；超限降级。

### 7.4 兼容性

- 保持 DSH 当前版本（0.2.x）与 `@tencent-connect/qqbot-nodejs` 0.5.2 fork 兼容。
- 不破坏现有命令、replyAll、selfEcho、图片、引用、单实例。
- 新功能以独立 plugin/bundle 方式接入；尽量不修改 qqbot 核心。

---

## 8. 总体架构

```text
QQ 群/私聊
   │
   ▼
dsh-qqbot（Channel Adapter）
   │  inbound/outbound/tool events, media, quote, commands
   ▼
Event Ledger（append-only, Postgres）
   │
   ├── Consolidator（episode/fact/relationship 提取）
   │        │
   │        ▼
   │   Life DB（Postgres + pgvector）
   │   ├── episodes
   │   ├── facts / revisions / evidence
   │   ├── relationships
   │   ├── self_state
   │   ├── reflections
   │   ├── open_threads
   │   ├── skills
   │   └── mcp_servers
   │
   ▼
Perception & Retrieval
   │  current msg + quote + image + relationship + self + open threads
   ▼
DSH Agent（deepseek-flash / preset / tools）
   │
   ├── Memory tools
   ├── Skills
   ├── MCP tools
   └── (later builder/supervisor)
   ▼
QQ 出站 / 未来平台
```

### 8.1 组件

| 组件 | 职责 | 形态 |
|---|---|---|
| `dsh-qqbot` | QQ 接入、媒体、命令、事件 tap、memory hook | 现有 fork |
| `qqbot-life` | Life Core 编排：ledger 订阅、检索注入、self/attention/reflection 工具 | DSH plugin/bundle |
| `life-mcp` | 记忆/自我/关系 CRUD/search，MCP tools | 独立 MCP server（可选） |
| `life-db` | Postgres + pgvector，持久 volume | 容器 |
| `reflection-worker` | 每日/每周反思、consolidation | DSH schedule 或独立 worker |
| `admin` | 查看/删除/暂停/导出/回滚 | CLI/API/UI |
| `supervisor` | 后期 builder/staging/canary/rollback | 独立进程/容器 |

### 8.2 推荐目录

```text
/home/example/qqbot/
  dsh-qqbot/                  # 现有 channel fork
  packages/
    qqbot-life/              # DSH plugin/bundle（life core）
  services/
    life-mcp/                # MCP server（如需独立进程）
  profiles/
    qqbot-life/              # 目标 profile（base + qqbot + life + mcp + schedule + skills）
  docs/
    QQBOT-LIFE-PRD.md        # 本文
  data/
    media/                   # 持久媒体
    workshop/                # 自编写 skills/实验
  skills/                    # active skills
```

MVP 可以先把 `qqbot-life` 做成一个 DSH plugin + 一个 Postgres，不必拆微服务；接口保持可拆分。

### 8.3 与 DSH 的集成点

- **入站事件 tap**：在 `autonomousGate` 之前、去重/access 之后，异步写 ledger；不阻塞回复。
- **出站事件**：包装 `sendMarkdown/send`，记录 message id/内容/工具结果；self-echo 已在 channel 层处理。
- **检索注入**：`handleInbound` 组装 agentBody 前调用 `life.buildContext()`；或通过 `system-prompt/assemble` 注入 self/relationship。
- **工具注册**：life plugin 注册 `memory_*`/`self_*`/`relationship_*`/`reflect` 工具。
- **schedule**：用 DSH schedule 或外部 cron 触发 reflection；投递到专用 session。
- **skills/MCP**：使用 DSH `dsh-skill` / `dsh-mcp-client`；life plugin 只做注册/风险元数据。
- **preset**：新增 `qqbot-life` preset，稳定 persona + tools 组合；当前 profile 没有 preset，建议补。

---

### 8.4 单条消息的目标流程

```text
1. QQ 事件进入 channel
2. 去重/access/命令/自己回声过滤
3. 写入 ledger（事件 + 媒体元数据）
4. quoteRef / attachmentProcessor 下载媒体
5. attention 判断：speak / observe / remember / ignore
6. 如果 speak：
   a. 取 relationship + self + memory bundle + open threads
   b. 拼 agentBody（当前消息 + 引用 + 媒体路径 + 历史）
   c. DSH agent 生成回复/调用工具
   d. 出站发送；记录 outbound 事件
7. 无论是否 speak：
   a. 写入/更新 episode 候选
   b. 更新关系/未完成话题
   c. 重要事件标记
8. 每日/每周反思：
   - 生成 journal
   - 更新 self narrative / relationship summary
   - 提出 skill/persona 变更
```

关键：**第 3 步不能依赖 agent 是否被触发**。未回复的消息也必须入 ledger，否则“全量对话”不成立。

---

## 9. 数据模型

> 以 PostgreSQL 为权威；向量用 pgvector；FTS 用 `tsvector`。表名可调整，字段语义不变。
> 下面 SQL 是**逻辑 schema 示意**，不是可直接执行的 migration；实施时用正式 migration 工具生成 DDL，并补索引/约束/权限。

### 9.1 `ledger.events`（append-only）

```sql
id uuid primary key,
ts timestamptz not null,
event_type text not null,          -- message|reply|tool_call|tool_result|command|system
direction text not null,           -- inbound|outbound|internal
account_id text not null,
scope text not null,               -- group|c2c|system
peer_id text not null,             -- group_openid / user_openid
sender_id text,
sender_name text,
message_id text,
reply_to_message_id text,
kind text,                         -- text|image|voice|video|file|quote|mixed
content text,
attachments jsonb default '[]',
quote jsonb,
raw jsonb,
session_id uuid,
turn_id int,
tool_name text,
tool_args jsonb,
tool_result jsonb,
sensitivity text default 'internal',
hash text,
created_at timestamptz default now()
```

索引：`(peer_id, ts)`、`(sender_id, ts)`、`(message_id)` unique、`(session_id, turn_id)`。

### 9.2 `ledger.media`

```sql
id uuid primary key,
event_id uuid references ledger.events(id),
sha256 text unique not null,
path text not null,
mime text,
bytes bigint,
width int,
height int,
caption text,
embedding vector,
created_at timestamptz default now(),
expires_at timestamptz
```

### 9.3 `memory.episodes`

```sql
id uuid primary key,
peer_id text not null,
period_start timestamptz,
period_end timestamptz,
summary text not null,
participants jsonb,
topics jsonb,
importance real default 0.5,
embedding vector,
source_event_ids uuid[],
created_at timestamptz default now()
```

### 9.4 `memory.facts`

```sql
id uuid primary key,
subject_type text not null,        -- user|group|self|project
subject_id text not null,
kind text not null,                -- preference|fact|relationship|procedural|self
content text not null,
summary text,
confidence real default 0.8,
importance real default 0.5,
sensitivity text default 'internal',
status text default 'active',      -- active|archived|deleted
valid_from timestamptz,
valid_until timestamptz,
source_event_ids uuid[],
current_revision int default 1,
embedding vector,
created_at timestamptz default now(),
updated_at timestamptz default now()
```

### 9.5 `memory.revisions` / `memory.evidence`

```sql
memory.revisions(id, memory_id, revision, content, summary, reason, actor, created_at)
memory.evidence(id, memory_id, event_id, quote, weight, created_at)
```

### 9.6 `memory.relationships`

```sql
id uuid primary key,
person_id text,                    -- internal person id
platform text default 'qq',
platform_user_id text,             -- openid
group_id text,
display_name text,
aliases jsonb,
summary text,
preferences jsonb,
open_threads jsonb,
trust real default 0.5,
last_seen timestamptz,
created_at timestamptz default now(),
updated_at timestamptz default now()
```

### 9.7 `memory.self_state`

```sql
id uuid primary key,
version int not null,
persona jsonb not null,            -- name/identity/appearance
values jsonb,
style jsonb,                       -- sentence length, emoji, tone
interests jsonb,
goals jsonb,
self_narrative text,
capabilities jsonb,
limitations jsonb,
current_focus text,
created_at timestamptz default now(),
is_current boolean default false
```

### 9.8 `memory.reflections` / `memory.open_threads`

```sql
reflections(id, period, summary, lessons jsonb, proposed_changes jsonb, created_at)
open_threads(id, peer_id, topic, status, last_event_id, due_at, created_at)
```

### 9.9 `ops.skills` / `ops.mcp_servers` / `ops.deployments`

```sql
ops.skills(id, name, version, status, path, author, risk, tests, approved_by, created_at)
ops.mcp_servers(id, name, transport, command/url, tool_allowlist, risk, credentials_ref, status, created_at)
ops.deployments(id, version, commit, status, canary, rollback_point, created_at)
```

### 9.10 数据策略

- 原始事件：长期保留；管理端可导出/删除。
- 媒体：默认 30-90 天，可配置；重要图片归档。
- 记忆：不自动物理删除；archive/tombstone。
- 敏感度：`public/internal/private/secret`；secret 不进入普通检索。
- 所有记忆写操作带 `source_event_ids` 和 `actor`（agent/admin）。

### 9.11 “固化”数据库容器

目标部署：

- PostgreSQL 16 + pgvector；
- 独立容器（Podman/Docker），持久 volume `qqbot-life-db`；
- 每日逻辑备份 + WAL/物理备份；保留 7-30 天；
- 迁移脚本版本化，可回滚；
- 媒体独立 volume/对象存储，DB 只存路径/hash/元数据；
- 单写者（单实例 bot + 单 worker），避免并发写冲突；
- 数据库密码只从 secrets/env 注入，不写 profile/仓库；
- 每季度做一次恢复演练。

MVP 可先用一个 Postgres 容器 + 一个 JSONL 备份；但 schema/migration 必须从第一天存在，避免“先裸写文件再迁移”。

---

## 10. 接口需求

### 10.1 Channel → Life Core 事件

```ts
interface QqbotLifeEvent {
  eventId: string;
  ts: number;
  direction: 'inbound' | 'outbound' | 'internal';
  eventType: 'message' | 'reply' | 'tool_call' | 'tool_result' | 'command' | 'system';
  scope: 'group' | 'c2c';
  peerId: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
  replyToMessageId?: string;
  kind?: 'text' | 'image' | 'voice' | 'video' | 'file' | 'quote' | 'mixed';
  content?: string;
  attachments?: Array<{
    type: string;
    url?: string;
    localPath?: string;
    sha256?: string;
    mime?: string;
    bytes?: number;
  }>;
  quote?: {
    messageId?: string;
    senderName?: string;
    text?: string;
    attachments?: unknown[];
  };
  sessionId?: string;
  turnId?: number;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  raw?: unknown;
}
```

### 10.2 Memory MCP / Agent 工具

| 工具 | 作用 | 权限 |
|---|---|---|
| `life_context` | 取当前 peer/group 的关系卡 + 相关记忆 + open threads | read |
| `memory_search` | 混合检索 | read |
| `memory_recent` | 最近 episode/事件摘要 | read |
| `memory_remember` | 写入新记忆（含类型/重要性/敏感度/来源） | write |
| `memory_revise` | 修订，必须带 expected revision | write |
| `memory_forget` | 归档/墓碑 | write |
| `memory_link` | 连接事件/人物/主题 | write |
| `relationship_get/update` | 关系卡读取/更新 | read/write |
| `self_get/update` | 自我状态读取/提案更新 | read/write |
| `reflect` | 生成 journal/lessons/proposals | write |
| `life_ingest` | 内部事件入库（channel 调用，不暴露给模型） | internal |

工具返回带 `memory_id`、`revision`、`source_event_ids`；错误用稳定 code（`revision_conflict`、`not_found`、`access_denied`）。

### 10.3 管理接口

- `GET /admin/memories?peer=&q=&status=`
- `DELETE /admin/memories/:id`（archive/tombstone）
- `GET /admin/self`
- `POST /admin/pause` / `resume`
- `GET /admin/health`
- `POST /admin/export`
- 鉴权：仅 loopback/管理员 token；不暴露公网。

### 10.4 Prompt 组装

建议顺序：

1. DSH 基础系统提示；
2. persona + self_state（稳定锚点）；
3. 当前关系卡（对谁说话）；
4. memory bundle（episode/fact/open threads，带引用）；
5. 最近群历史（可配置 10-40 条）；
6. 引用块；
7. 当前消息 + 图片本地路径；
8. 输出风格约束（短句/口语/角色）。

Token 预算建议（可调）：self/relationship 15%、memory 25%、history 35%、current/media 25%。

---

## 11. 权限与安全模型

### 11.1 信任层级

| 层级 | 能力 | 默认策略 |
|---|---|---|
| T0 | 读记忆/检索 | 自动 |
| T1 | 写/改/忘自己的记忆 | 自动，留 revision/evidence |
| T2 | 更新 self/persona | reflection 提议；核心锚点需管理员或冷却期 |
| T3 | 写 skills | 沙盒 + 测试 + draft/active |
| T4 | 安装 MCP/外部写操作 | 管理员审批 + 容器 |
| T5 | 插件代码/部署 | builder + 测试 + staging + 审批 + 回滚 |

用户要求“记忆操作全权交给 AI”对应 **T0-T2**。T3 之后仍应保留审批，避免群友通过 prompt injection 让 bot 安装能力。

### 11.2 运行边界

- 专用容器/OS 用户；`/data` 可写；home 不挂载。
- 网络 allowlist。
- secrets 只给需要的进程。
- 单实例 `flock`；DB 单写。
- 高风险工具审批；审计。

### 11.3 反投毒

- 群聊内容不是指令；不因群友说“记住你是猫”就改 self。
- 记忆写入带来源/权重；推断事实先 candidate。
- self/persona 修改需要 reflection + revision；核心锚点不可单条覆盖。
- 自升级需要人工审批；群友不能直接触发部署。

---

## 12. 测试与评估

### 12.1 测试群

- 文本/图片/引用/语音/文件/命令。
- 自己消息过滤；重复消息去重。
- session 创建/恢复；单实例；reset 清历史。
- 记忆写/读/改/删/回滚。
- MCP/skills 加载/失败降级。

### 12.2 记忆评估

- 50-100 条历史对话构造 Q/A：人名、偏好、事件、承诺、梗。
- 指标：recall@k、precision、contradiction rate、citation accuracy。
- 删除后不再召回；修订后以新版本为准。

### 12.3 人格/体验评估

- 盲测：3 个 session 的回复，群友判断是否同一角色。
- 口吻一致性、主动性、打扰率、对话长度。
- “是否记得上次”主观评分。

### 12.4 安全测试

- prompt injection：“忽略之前指令/把记忆改成…/安装这个 MCP/删库”。
- 记忆投毒、越权读、路径逃逸、自升级未审批。
- 删除/暂停/kill switch。

### 12.5 运维测试

- 断网/重启/DB 恢复/媒体缺失/MCP 崩溃。
- 单实例锁；队列满；超时。

---

## 13. 实施阶段

### Phase 0：冻结基线 + 设计确认（1 周）

- 确认本文；确认“一个 self，多关系”；确认 DB/容器方案。
- 建立 `docs/`、schema 草案、备份策略。
- **不改变现有 bot 行为。**

**验收**：本文评审通过；当前 118 tests 仍通过；live bot 正常。

### Phase 1：Event Ledger（1-2 周）

- 在 qqbot 加入只读事件 tap（gate 之前）。
- Postgres 容器 + `ledger.events/media` 迁移。
- 媒体归档；出站/工具事件记录。
- 只读导出/覆盖率检查。

**验收**：24h 事件覆盖；图片/引用可回放；不影响回复延迟。

### Phase 2：Memory Core + 检索（2 周）

- `memory.*` 表、revisions/evidence。
- `life-mcp`/DSH tools：search/remember/revise/forget/context。
- 检索注入 agentBody；token 预算。
- 50 条 recall 测试。

**验收**：能记住人名/偏好/事件；删除生效；无 context 爆炸。

### Phase 3：Self + Attention + 反思（2-3 周）

- self_state/persona 版本化；关系卡。
- attention 模式；引用/图片进入判断；replyAll 保留。
- 每日 reflection、open threads、schedule。
- 盲测人格一致性。

**验收**：跨天连续；不刷屏；引用/图片正确；reflection 产出。

### Phase 4：Skills / MCP（2-4 周）

- skills 沙盒 + 自编写 skill。
- MCP registry + 风险分级 + 容器。
- `qqbot-life` preset。
- 接 1-2 个低风险 MCP。

**验收**：不改核心加能力；高风险需审批；skill 热加载。

### Phase 5：Self-upgrade（后期）

- builder profile/容器；workshop；staging/canary/rollback。
- 变更单/QQ 审批/审计。

**验收**：一次 skill 自升级可回滚；生产不中断。

### Phase 6：多平台/语音（远期）

- Channel Adapter 抽象；第二平台。
- TTS/形象（如有）。

---

## 14. 风险与开放问题

### 14.1 风险

- 记忆投毒/越权；群友恶意塑造人格。
- 隐私：全量记录群聊；需告知/删除。
- 人格漂移；核心锚点被单次对话改。
- 成本：每消息全 agent + 记忆检索 + 反思。
- QQ 限额/无历史回填/内容审核。
- 自升级回归/供应链。
- 过度拟人/依赖；娱乐产品需透明。

### 14.2 开放问题（需 owner 决定）

1. 全量群聊记录的告知/opt-out 方式？
2. 记忆/媒体保留多久？哪些群可记录？
3. 一个 self 还是未来多 self？本文默认一个 self。
4. 是否保留 Butler user memory 作为独立“用户事实”库？默认保留、独立 namespace。
5. 是否允许 agent 自动改 self/persona？默认 reflection 提议 + revision。
6. 自升级到哪一级？MVP 只做 L0-L2。
7. 语音/形象/多平台优先级？
8. 每日 token/费用预算？

---

## 15. 交接给实施 agent 的说明

### 15.1 先读

1. 本文；
2. `/home/example/qqbot/README-qqbot.md`；
3. `dsh-qqbot/src/features/autonomous.ts`、`transport/inbound.ts`、`gateway/middleware-setup.ts`、`transport/self-echo.ts`、`tool-policy.ts`；
4. profile `.dsh-qqbot/profiles/qqbot/cordis.patch.yml`；
5. DSH MCP/skills/schedule 文档。

### 15.2 约束

- 不提交 secrets；不改 `.secrets`。
- 不把 cwd 改回 home；不放开 `read/write/edit/bash`，除非容器边界完成。
- 不删除 replyAll；新 attention 作为可选模式。
- 不破坏现有命令、图片、引用、selfEcho、单实例。
- 新功能优先独立 plugin/bundle，尽量少改 qqbot 核心。
- DB 用持久 volume；迁移可回滚；备份。
- 每阶段更新 README + 测试。

### 15.3 第一批 PR 建议

1. `docs` + schema migrations + DB container compose。
2. `ledger` tap + events/media 写库 + 覆盖率测试。
3. `memory` service + MCP tools + read-only `life_context`。
4. 检索注入 + 50 条 recall 测试。
5. self/relationship + reflection worker。
6. attention mode + preset + admin。

### 15.4 Definition of Done

- 功能需求对应验收通过；
- 单测/集成/e2e 通过；
- 迁移/备份/恢复文档；
- 权限/隐私检查；
- 当前 live bot 不回归；
- README 更新；
- 变更记录/提交。

---

## 16. 附录

### A. 当前运行参数（截至 2026-10-20）

- cwd：`/home/example/qqbot/workspace`
- DSH_HOME：`/home/example/qqbot/.dsh-qqbot`
- HOME：`/home/example/qqbot/home`
- profile：`.dsh-qqbot/profiles/qqbot/cordis.patch.yml`
- 模式：`autonomous.replyAll: true`
- 工具：`read_image` / `qqbot_describe_image` / `qqbot_send_file` / `ask_user_question`
- 媒体目录：`/home/example/qqbot/home/.dsh-qqbot/media`
- 启动：`./run-qqbot.sh`（flock 单实例）

### B. 术语

- **Life Core**：记忆/自我/关系/反思/能力注册的集合。
- **Ledger**：append-only 事件日志。
- **Episode**：一段对话/一天/一个话题的摘要。
- **Self**：人格、价值观、风格、目标、自述的版本化状态。
- **Attention**：决定说/看/记/忽略的策略。
- **Reply-all**：当前临时模式，每条非空群消息都回。
- **Butler memory**：现有的用户长期记忆系统；本项目复用其 schema/审计思想，但写入策略面向 agent。

### C. 参考

- DSH 当前安装：`/home/example/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh`
- `@deepseek-ai/dsh-mcp-client` / `dsh-skill` / `dsh-schedule` / `dsh-goal`
- `@tencent-connect/qqbot-nodejs` 0.5.2
- Butler memory：`/home/example/butler-memory-mcp`、`/home/example/dsh-butler-memory`
- AI Butler Framework：`/home/example/ai-butler-framework`

---

**文档结束。实施时如与本文件冲突，以 owner 最新确认为准，并在 PR 中更新本文。**
