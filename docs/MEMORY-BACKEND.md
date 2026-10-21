> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# Life Core 记忆后端第一片：2026-10-20

第一版在独立 PostgreSQL 中保存有证据的事实/事件记忆，向 DSH 注册受限工具。常规写、改、忘由 agent 执行，不要求管理员逐条确认；这是本项目 PRD 的授权方式。

后续同日已升级 schema 4，增加统一人物身份、可共享个人事实与普通明确偏好自动保存，范围不再全部以会话隔离；当前增量与边界见 [人物与跨群记忆](PERSON-MEMORY.md)。2026-10-21 的 schema 5 又加入后台增量整理，见 [自主整理](MEMORY-CONSOLIDATION.md)。下文保留第一片的设计与验收背景。

## 数据与调用路径

```text
QQ message → immutable inbound event → leased job
                                    ↓ trusted scope / actor / writer
DSH memory_* tools → MemoryStore → memories + revision + evidence + audit
                        ↑
next turn / new session ← scoped lexical search + bounded recent bundle
```

`life-core` 不依赖 QQ、OneBot、DSH 或模型供应商。适配器闭包绑定 job/conversation、当前发言者、writer 与 owner 列表；模型不能传参数切换群、数据库或权限。每次读写检查任务租约、worker 和 conversation；写入与 revision、evidence、domain event 在同一事务提交。tool call ID 提供同一任务内的操作幂等，内容摘要用于精确去重。

Schema 3 增加 `life_memories`、`life_memory_revisions`、`life_memory_evidence`、`life_memory_links`、`life_memory_ops`。revision/evidence 对运行账号仅可追加；管理员负责迁移、导出和物理清理。独立客户端重建后仍可检索，不依赖旧 DSH session。

## 当前工具与行为

| 工具 | 范围 |
|---|---|
| memory_search / memory_recent | 当前 conversation；默认 active、internal、未过期；显式 include_candidates 可查看候选 |
| life_context | 同范围事实记忆；尚不包含关系卡、动态 self、open threads |
| memory_remember | 带来源事件和原文 quote 的 semantic / episodic 记录 |
| memory_revise | expected_revision 乐观锁、新证据、修订原因；保留旧版本 |
| memory_forget | tombstone；后续检索排除；保留历史与审计 |
| memory_link | 当前 conversation 中两条非遗忘记录的 related / contradicts / supports 关系 |

来源必须是当前任务或更早、同群的真实 inbound event，quote 必须出现在来源正文中。不会用机器人自己的回答、其他群事件或未来消息作为证据。自述的用户身份必须与来源 actor 一致；群事实需要可信 owner 来源。推断、疑似问题/角色指令、标记为 sensitive 的资料进入 candidate；候选不自动回填 prompt。密钥样式内容拒绝写入；完整敏感信息识别尚未实现。

这是一组保守的规则与来源约束，不是语义真实性证明，也不能保证完全抵御记忆投毒。昵称、图片和引文不能提升权限；来源全文的问句/指令检测防止摘取“我喜欢”片段绕过。修改/遗忘个人记忆只允许该用户或可信 owner；群/项目记录修改只允许 owner。初版不支持无人触发的自主清理任务。

同一个 subject + slot 出现不同内容时，新记录先成为候选并关联冲突，不静默替换旧事实。明确更正使用 revise。被修订掉的精确旧内容、已遗忘的精确内容不能通过 remember 直接复活；这不等于支持语义近似去重或所有改写形式的防复活。

检索使用 PostgreSQL FTS、中文单字/相邻双字词和英文/数字关键词，结合 importance / 更新时间排序。它是**词法检索**，没有使用向量或 embedding。每轮最多注入 6 条有界记忆，保留 id、revision、来源 ID；不会把整个事件账本装进 prompt。工具每轮最多 12 次。检索资料以不可信数据提供，不可改写系统身份/工具权限。

`/new` 清除短期会话与近期图片索引，保留长期记忆。revise/forget 会刷新记忆 bundle，并让下一轮重建 DSH session，避免继续沿用旧工具结果。当前轮和原始聊天仍可能包含旧内容；逻辑遗忘不承诺物理抹除它们。

## 配置与管理

本机 `data/config/adapter.json` 中 `memory.enabled=true` 已启用，`contextLimit=6`；当前版本已迁移 schema 4 并启用 personalProfiles。示例默认关闭；新环境先执行全部迁移。凭据、实际群号、聊天、运行证据不提交 Git。

```sh
scripts/life-admin memory-list --conversation onebot:ACCOUNT:group:GROUP
scripts/life-admin memory-search --conversation onebot:ACCOUNT:group:GROUP --query 茶
scripts/life-admin memory-history --conversation onebot:ACCOUNT:group:GROUP --memory-id UUID
scripts/life-admin memory-pause
scripts/life-admin memory-resume
scripts/life-admin export --conversation onebot:ACCOUNT:group:GROUP --output /PRIVATE/export.json
scripts/life-db backup
scripts/life-db verify-backup backups/life-TIMESTAMP.dump
```

`memory-list` 显示包括 candidate/forgotten 的当前行；history 显示各 revision 和证据。暂停记忆写入后可继续检索/聊天，写工具会明确失败。全群物理清理仍使用停服后的 `scripts/life-delete`，会传播到 memories/revisions/evidence/links/operation cache；不会撤回 QQ、模型服务端或已有备份内容。数据库备份包含记忆，但仍不包含媒体/DSH/QQ 数据文件，完整迁移边界见基础层说明。

## 验证与后续

自动验收在独立测试数据库运行，不清空生产群：同源事务回滚、并发幂等、精确去重、范围/时间/来源校验、问句/指令/推断/敏感内容、并发 revision、slot 冲突、遗忘与 session 失效、暂停写入、租约隔离、运行账号权限、导出/删除传播、独立客户端持久恢复。SDK 层另测参数越权、调用预算、错误脱敏和上下文上限。

50 条合成中文自述样例的 backend recall@3 为 50/50，跨群查询为空。这只证明该词法样例集，不等于 PRD 要求的 50 条真实历史对话或模型回答准确率。

完整自动检查共 **67 项通过**（Life Core 35，适配器 32）。真实 DSH + 模型 API 的独立验收也通过：实际 memory_remember 入库，`/new` 后新 session 回答乌龙茶，另一模拟群未获得该偏好，revise 变为红茶/revision 2，forget 变为 forgotten/revision 3。含 1 条记忆、3 个 revision、2 条 evidence 的非空备份实际恢复并复核成功。测试只使用本地模拟 OneBot 收发与独立数据库/profile，不向真实 QQ 群投递；证据在忽略的 `evidence/memory-runtime.json`。

可选择执行下述验收，它会调用当前 bot 的真实模型 API 并产生用量。隔离数据库结束时删除，因此这些开发测试用量不计入生产 `life-admin usage`，应以平台账单核对。全量单元/数据库检查不调用模型 API。

```sh
set -a
. data/config/model.env
set +a
node scripts/verify-memory-runtime.mjs
```

第一片人工验收曾被 22:42 登录失效阻断。重新登录后的跨群阶段已补真实人工验收：普通自述先由 observer 修订原本地事实并升为 person，在另一群正确召回，博士在本聊天确认；最新证据与范围见 [人物记忆验收](PERSON-MEMORY.md)。

下一片应做带真实 Q/A 的记忆质量评估，再接入异步 episode consolidation、语义向量检索、近似去重、关系卡、self、反思/衰减及版本回滚。此版完成了 FR-3 的基础闭环，尚未完成整个记忆系统。
