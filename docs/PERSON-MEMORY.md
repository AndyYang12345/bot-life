> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# 统一人物身份与跨群个人记忆

2026-10-20，schema 4。当前为同一个 bot 实例建立统一人物身份和可共享的事实记忆，后台自主整理已在 schema 5 接入，见 [自主整理](MEMORY-CONSOLIDATION.md)；完整关系模型尚未实现。

## 身份和记忆范围

```text
QQ account ID ── trusted realm + platform ── person_id
                   │                        │
group A nickname ──┤                   shared preferences
group B nickname ──┘                        │
                                      group A / group B

group episodes / local-only facts ── remain in their source conversation
```

身份键为 `(realm, platform, platform_user_id)`；OneBot 适配器使用当前 bot 账号的 namespace、`qq` 和消息真实 user_id。模型不能指定 realm/person_id 或绑定任意账号。昵称/群名片只作为各群别名，同名不同账号不会合并，跨平台不会根据昵称推断是同一人。不同 bot 实例也不会自动共用人物数据。

新增表为 `life_people`、`life_conversation_people`、`life_person_aliases`；消息与人物观察在同一事务入库。旧待处理消息可以在领取其合法任务后补身份元数据。没有全量回填历史人物，也没有把旧事实批量发布成跨群记忆。

每条 memory 分开记录所属者 `person_id` 与 `visibility`：

| visibility | 行为 |
|---|---|
| conversation | 当前群/私聊的事实与经历；按来源会话检索 |
| person | 当前发言人允许共享的稳定个人事实；同一人物在其他已启用会话中可召回 |

当前共享类别仅为 `preference` 与 `communication`：可靠本人自述、semantic、internal、带真实来源证据。私聊、事件经历、第三方推测、问题/角色指令、敏感或仅限本群的信息不能升为 person。identity 由可信适配器绑定；显示名不会提供身份或写入权限。

检索合并“当前群记忆 + 当前发言人的共享档案”，优先当前人物的匹配记录；没有按任意 QQ 号查人、按昵称合并或跨群浏览别人的工具。原群仍可看到其本地发生的内容。跨群结果不返回来源群号、其他群名片或原始引文，来源 event_id 仅在当前群可见时返回；记忆的自然语言 content/summary 本身仍是经策略允许共享的事实。

类别/规则检查是保守防线，不是完整敏感信息识别或语义真实性证明。共享文本仍视为不可信资料，不可改写角色、权限或系统指令。

## 普通自述自动入库

第一轮人工测试揭示了一个区别：模型面对“记住：我喜欢乌龙茶”会写工具，但面对普通“我喜欢乌龙茶”曾直接回复“记住了”而未调用工具。人物身份已经归并，跨群空结果的原因是未实际写入。

已增加有界 `observer:self-report-v1`，在模型回复前读取当前真实 inbound event：

- 只识别简短、完整、明确的本人偏好/交流习惯；例如“我喜欢乌龙茶”“我习惯用简短的回复”。
- 不要求说“记住”；不把问题、举例、测试设定、转述、玩笑、临时偏好或限制分享的句子自动升为事实。
- 每条消息最多处理一条偏好；原句作 evidence，独立 writer、固定操作键和审计。它不额外调用模型 API。
- 同一条偏好重放精确去重；“喜欢喝乌龙茶”与“喜欢乌龙茶”的简单表达可归一。
- 如果当前群已有证据精确匹配的本地事实，使用这次新的本人自述修订原行并升为 person，保留原 revision；不会留下一个继续被召回的本地镜像。
- 遇到复杂、多轮或不明确的信息，仍交给 agent 工具与后续后台整理，不假装这个规则已理解所有自然语言。

入库结果通过 `context.preference_observation` 和本轮有界上下文提供给模型；只有 active 写入成功后才应确认记住。暂停写入、来源或共享限制都会如实记录失败，QQ 离线时不领取新模型任务。模型其余写操作仍走 `memory_*`，不逐条请求管理员批准。

## 修订、遗忘与来源撤销

共享事实可在另一群用该用户的新证据修订，expected_revision 防止静默覆盖。修改/遗忘仍检查当前发言者身份；本群可见不等于任何成员都有修改权。来源仍保留在最初记录的会话，后来每个 revision 可有其他会话的证据，且原始引文不会在跨群查询中返回。

修订和逻辑遗忘会令相关人物所在会话的 DSH session 指针失效，下一轮重新建短期上下文；`/new` 本身保留人物和长期记忆。过时工具操作的成功缓存不会在后来遗忘后继续返回“已记住”的旧结果。

管理员删除某群时，删除该群本地记忆，以及任何以该群事件为来源证据的共享记忆；清理相关 revisions/evidence/links/操作缓存，撤销相关会话 session，移除该群别名与人物关联。仍在其他群出现的人物继续存在；最后一个关联删除后清理其人物行。

范围导出只含该群的原始事件、别名和原始 evidence；已经产生在其他群的聊天/审计副本属于对应会话，不随本群删除。逻辑遗忘也不撤回 QQ、模型服务端、原始账本或已有备份。缓存失效不等于物理擦除全部副本。

## 配置与本机管理

先停适配器、备份并迁移，再启用私有策略中的 `memory.personalProfiles=true`；本机已启用。迁移原样保留原有事实和 revision，旧记录默认 conversation，只为检索补充中文字索引。

```sh
scripts/life-admin person-list
scripts/life-admin person-show --person-id UUID
scripts/life-admin memory-list --conversation onebot:ACCOUNT:group:GROUP
scripts/life-admin memory-history --conversation onebot:ACCOUNT:group:GROUP --memory-id UUID
scripts/life-admin memory-pause
scripts/life-admin memory-resume
scripts/life-db backup
scripts/life-db verify-backup backups/life-TIMESTAMP.dump
```

`person-show` 是可信本机管理命令，可查看此人物所有群的别名和记忆；模型的 `person_get` 仅返回当前发言人身份及本群别名。`memory-list/search/history` 的 conversation 参数仍表示管理所选来源范围。

开发验收使用独立数据库、临时 DSH profile 和本地模拟 OneBot，不向真实 QQ 群投递。带真实模型 API 的验收产生独立 bot key 的用量，隔离库完成后删除，不计入生产 usage 汇总：

```sh
scripts/check-project
set -a
. data/config/model.env
set +a
node scripts/verify-memory-runtime.mjs --personal-profiles
```

## 后续自主整理与能力

博士已明确：自主整理不以“强制记住”指令为前提。后续 consolidation worker 应从原始账本增量处理普通聊天，提取跨多轮的偏好、共同经历、开放话题；保留事件证据和置信度，推断先 candidate，使用来源游标、任务租约、重试幂等和预算。删除/遗忘必须阻止旧任务重新产生已撤销资料。反思再总结关系和她自己的反应，不能把猜测写成用户事实。

本节保留 schema 4 的路线背景；schema 5 已增加按用户和群分批的普通聊天整理，带租约、预算、候选与遗忘边界。关系卡、self、向量检索、衰减和反思仍未完成。网页搜索/阅读也仍是后续只读能力，应独立放行、限制调用与费用，保留来源链接；网页内容不获得记忆写入或系统执行权限。

## 本轮验收

- 全量构建、类型检查和 **107 项自动测试通过**：Life Core 74，适配器 33；包含真实 PostgreSQL、非空 schema 3 升级不扩权、同人跨群、同名不同人、别名/原始证据范围、普通自述和旧本地记忆升格、重放去重、敏感/歧义拒绝、跨群修订/遗忘、导出/删除传播与权限恢复。
- 真实 DSH + 模型 API 隔离验收通过：预置与现场相同的旧本地偏好，发送普通“我喜欢乌龙茶”后升为 person；换昵称、换群仍正确回答；同名不同账号不认成同一人；另一群修订/遗忘后原群不再召回。1 条记忆、4 个 revision、3 条 evidence、2 个人物的非空备份实际恢复成功。
- 真实 QQ 人工验收先失败于“口头记住、未入库”，补自动 observer 后复测通过。博士确认跨群回答正确；运行库核验为 1 个 canonical person、2 个群关联、原记忆升为共享 revision 2、无 active 本地镜像、2 条 confirmed 发送，两群回答均包含乌龙茶。
- 机器证据位于忽略的 `evidence/person-runtime.json` 与 `evidence/person-live-acceptance.json`；真实账号、群号、昵称、原始聊天和凭据不进入 Git。
