> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# Life Core 第一阶段：账本与恢复队列

实施日期：2026-10-20。当前仅在已授权的“测试群”群运行，私聊关闭。原官方 QQ bot 未改动。

## 数据流与提交边界

1. OneBot 适配器核对登录账号、会话白名单、自身消息，选择消息字段后写入本地 spool；临时文件和目录均 fsync。重复消息不会覆盖尚未入库的原副本。
2. PostgreSQL 一个事务内追加 `inbound.message` 并建立任务；唯一键包含 transport、account、scope、peer、source message ID。提交成功后才删除 spool。
3. worker 通过 `FOR UPDATE SKIP LOCKED` 领取每个 conversation 最早的任务。租约 60 秒，每 15 秒续期；任何输出准备和发送状态更改都校验 owner 和有效租约。
4. 归一化文本、作用域已核验的引用、媒体元数据、`read_image` 调用及结果进入账本。二进制图片保存于媒体目录，工具结果保留引用而不在 JSONB 复制 base64。完整轮次显式 flush DSH session 成功后再准备出站。
5. 助手最终文本和分块 Outbox 在同一事务准备。模型最多输出 6000 个 Unicode 字符，每块 2000 字符；每轮模型和每条出站都有持久预算占位。
6. 发送前提交 `dispatching`。明确成功回执记为 `confirmed`；明确 OneBot 业务拒绝记为 `failed`；网络异常、回执缺失或中途崩溃记为 `unknown`。`unknown` 不自动重试。

已进入 spool/数据库的输入可以在进程恢复后续处理；适配器与 NapCat 断开期间的消息没有接收证明，不在此保证内。当前没有自动拉取 QQ 历史。

模型生成阶段中断时，旧 DSH session 可能已有部分输入或输出。恢复会审计 `turn.interrupted`，从新 session 重算这一任务，防止同一个输入重复追加到旧 session；这可能损失该 session 的短期上下文并重复消耗模型计算。长期记忆回灌属于下一阶段。若输出已经进入 Outbox，则直接恢复待发送块。

任务失败重试最多三次，连续强杀到达上限会保留 failed 状态。已发生的发送保持 confirmed/unknown，不会因为任务失败而清空。管理员通过状态和导出排查，当前没有自动重发 unknown 的管理命令。

`maxQueue` 现在控制每批从 spool 入库的数量，默认 20；积压留在磁盘，不再因内存队列满而丢弃。当前只有一个模型 worker。spool 没有总容量配额或自动历史回填；磁盘写满会显示接收失败，无法宣称任意故障下零丢失。

## Schema 与权限

| 表 | 用途 |
|---|---|
| life_events | 追加事件，来源、会话、actor、cause、发生/记录时间、payload |
| life_jobs | 待办状态、生成阶段、尝试次数、租约、下次执行时间 |
| life_outbox | 已准备的文本块、发送状态、平台回执 |
| life_blobs / life_event_media | 内容 hash、文件元数据及多对多引用 |
| life_conversations / life_session_links | 当前及历史 DSH session 关联 |
| life_rates / life_settings | 持久预算及暂停状态 |
| life_legacy_seen | 首版去重迁移及删除后去重墓碑，不含消息正文 |
| life_migrations | 已执行的 schema 版本，当前 2 |

`life-core/` 不依赖 DSH/QQ；`dsh-onebot/` 负责账号授权、媒体处理和 DSH 生命周期。数据库使用独立容器 `napcat-life-postgres-1`、独立 bind volume 和随机密码，只绑定 `127.0.0.1:15432`。没有复用 Butler 的数据库。

运行身份 `life_app` 无事件修改、删除、建表或切换管理员身份权限。管理员凭据与运行凭据分开。密码只保存在受限本地文件，不写进源码、命令行、连接 URL、导出或聊天。

迁移只前进；升级前备份。回退应用代码不代表 schema 已回退。当前首版旧 JSON 的去重、session、暂停和未过期预算仅迁入一次，不回填旧消息，也不尝试恢复旧版已丢失的任务。

## 暂停、导出与删除

`pause` 停止新模型回复，仍记录允许范围的入站；管理命令仍可使用。已经开始的模型计算可能继续，发出前再次核对暂停状态并取消待发送块。恢复不会补说暂停期间已标记 skipped 的消息。`/new` 只换会话，不代表删除账本。

导出必须指定完整 conversation 和新文件路径，使用事务一致性快照，文件权限 0600。导出包含该范围的事件、任务、出站和媒体/session 元数据，不包含数据库密码和图片二进制文件。

范围删除在本地管理员执行，停止服务后进行：

```sh
scripts/life-admin pause
scripts/onebot-adapter stop
scripts/life-delete --conversation onebot:ACCOUNT:group:GROUP
```

它会删除该范围数据库内容，清理关联 spool、已知 DSH session、本地媒体的无引用副本，并保留无正文的去重墓碑及管理审计。其他范围仍引用的 blob 保留。仅当整个隔离实例不再有其他范围时，才清理共享 DSH 附件/提供商缓存和剩余媒体；多范围共享缓存的细粒度回收尚未实现。

删除计划写到 `data/deletions/`。清理中断时保持服务停止，用 `scripts/life-delete --resume /ABSOLUTE/MANIFEST.json` 继续。完成后自行启动服务和 resume；工具不会自动恢复回复。

此命令处理 Life 层及已知本地适配器副本，不会从 QQ 服务器、NapCat 账号缓存、模型提供商或已有备份撤回数据。备份和既有导出需按同一删除要求另行处理，恢复旧备份前也须考虑删除墓碑。

## 备份与恢复

```sh
scripts/life-db backup
scripts/life-db verify-backup backups/life-TIMESTAMP.dump
```

备份是 PostgreSQL 自洽快照，0600，目录忽略入 Git；`verify-backup` 在新建的独立数据库恢复并检查 schema/事件/任务/出站，然后删除验证库。它不会覆盖运行库。

数据库备份不含媒体或 DSH 文件。完整实例迁移还需要在适配器停止后另行备份 `workspace/media`、`data/adapter` 和 `data/dsh-home`，并安全保存本地配置、权限和账号数据；当前未实现全实例一键恢复。备份没有额外文件加密和自动轮转。

## 本轮验收证据

| 场景 | 实际结果 |
|---|---|
| 真 QQ 文字、图片、引用图片 | 3 个任务完成、3 条发送 confirmed；博士在本聊天确认均可见且描述准确 |
| 媒体与工具链 | 1 个 blob，原图/引用各有关系；两轮均有 tool.call 与 tool.result |
| 数据库实际停机 | health.database=false，spool 留存；重启后回放，同一旧事件未重复发送 |
| 适配器 SIGKILL | systemd 自动恢复，session 关联保留，3 条历史发送未重发 |
| 非空数据库备份恢复 | 独立数据库恢复 schema 2、31 条事件、3 个任务、3 条 Outbox |
| 独立 PostgreSQL 用例 | 并发去重、事务回滚、串行/并行领取、租约隔离、输出恢复、子进程强杀后 unknown、不重复分块、预算、迁移、权限、范围导出/删除 |
| 本地删除边界 | 保留跨范围共享文件、拒绝路径/符号链接逃逸，支持清理续跑 |

机器证据保存在忽略的 `evidence/life-*.json`；不把聊天正文、群号、模型密钥或账号数据提交到 Git。后续已补容器重建后的 QQ 缓存自动登录和第二群 ping 验收，见 [登录恢复](CHANNEL-RECOVERY.md)；长时间稳定性、服务端撤销票据后的恢复和断开期间补历史仍未验收。

队列锁与持久提交的依据：[PostgreSQL 16 SELECT / SKIP LOCKED](https://www.postgresql.org/docs/16/sql-select.html)、[PostgreSQL 16 WAL 设置](https://www.postgresql.org/docs/16/runtime-config-wal.html)。

2026-10-20 已交付以 event_id 为证据的记忆写入/检索、revision、逻辑遗忘和范围删除传播，见 [记忆后端](MEMORY-BACKEND.md)。没有把全量账本直接塞入 prompt；跨天实际运行、异步整理与完整长期记忆质量仍需持续评估。

## 图片顺序回归

博士在 19:37 的实际测试发现：“上一张图”首次回答把像素角色与马克杯倒置，后续追问又能自行纠正。只读核对显示数据库顺序与 DSH session 日志均正确；因此恢复了 session ID 和内容，不等于模型对顺序的每次回答都可靠。

已补最近三张原始图片的会话索引，通过动态上下文提供 event_id、接收顺序和本地原图路径，回答最近图片时要求 read_image 重新核验。引用原图不新增一个上传位置；同一消息多图片保留 segment 序号。索引只查询当前 conversation、当前任务之前的消息，且尊重 `/new` 的上下文边界。工具 guard 进一步限制为本轮输入和同范围索引授权的图片集合。

这是有界近期图片指代修复，不是通用长期记忆。已用 PostgreSQL 测试覆盖像素→杯子→引用像素的顺序、跨范围隔离、未来消息排除，以及批量入站后 reset 边界。部署后博士再次询问“上一张图是什么”，实际记录显示索引上下文、1 次 read_image、session flush、明确回答马克杯及出站 confirmed 均成功，博士在本聊天确认正确。证据为 `evidence/life-image-order-regression.json`。

## 独立 API 密钥与用量

按博士要求，运行服务已切换到 `data/config/model.env` 中新建的独立 DeepSeek API key。已核验它与原 QQ bot 的密钥不同、文件权限 0600、API 鉴权通过、实际服务进程使用新值，且文件被 Git 忽略。原 QQ bot 的凭据文件未修改。源码和账本只使用标签 `qqbot-independent`，不保存密钥或密钥摘要。

每个 DSH assistant/message 的 SDK usage 都通过 fsync spool 进入 `model.usage`，保留 uncached input、cache read/write、output 和 reported total，不把缓存命中重复计为未缓存输入。没有报告 usage 的响应/失败尝试记为 `model.usage_unavailable`。不承诺所有中断/失败调用都有完整 token 账单。

`scripts/life-admin usage` 默认汇总最近 24 小时，可指定 `--since/--until` ISO 时间及 `--conversation`。只统计功能启用后的观测请求；不把此前共用密钥的历史消耗归到新 key。它提供 token 核对，不换算货币或代替平台账单。当前已有模型任务/发送次数预算，尚无每日金额硬上限。

完整检查为 43 项通过（Life Core 20，适配器 23），包含真实独立 PostgreSQL 用例。实际生产群数据未用于清空/删除测试。
