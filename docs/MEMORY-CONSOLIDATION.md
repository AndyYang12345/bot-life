> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# 后台自主整理记忆

2026-10-21，schema 5。普通聊天不必以“记住”开头；独立后台进程从已入账的发言中增量提取有证据的记忆，不向 QQ 发消息，也不运行额外 DSH agent。

```text
inbound events → per-conversation/per-actor cursor → leased memory task
                                                    ↓
                               bounded JSON extraction + reported usage
                                                    ↓
                                       persist immutable decisions
                                                    ↓
                    MemoryStore evidence/policy/dedup → fact or local candidate
                                                    ↓
                                 next chat turn retrieves active memories
```

## 这一片的范围

- 来源是同一用户、同一会话的多条已入账发言，身份由通道绑定。source event 和原文 quote 必须实际存在，不能引用另一群、另一人或机器人输出。
- 可靠的明确自述沿用 MemoryStore 的事实门槛；符合原有人物共享策略的稳定偏好/交流习惯可以跨群召回。复杂句不要求命中前一版 observer 的单句正则。
- 推测、问题、假设/举例、低置信度、隐私和开放话题保守保留为本群 candidate，不自动放进正常聊天上下文。经历保持本群范围。此片不自动改写已有事实、合并人物、修改 self 或发送跟进消息。
- 模型看到最多 6 条当前用户可见的已有记忆，用于语义去重与识别冲突；精确去重仍由数据库内容摘要保证。矛盾保留候选，允许的同范围记录增加 contradicts 链接；跨范围不放宽链接权限。候选升级依靠后续合法证据与显式 revise，尚无自动批准流程。
- 这不是完整敏感信息识别或语义真实性证明。原文校验能证明“引用确实存在”，不能数学上保证模型结论完全由它蕴含。

## 增量、预算与恢复

部署迁移会把此前已有发言设为游标基线，**不批量挖掘旧群聊**。新消息满足以下条件后才进入整理：同用户同群累计 3 条，或最早待处理消息已等待 5 分钟；worker 每 30 秒检查。实际执行仍受全局预算与积压影响。

每批最多 12 条、累计最多 6000 字符的来源文本；单条超过 1500 字符、疑似凭据、指令注入、命令或明确要求不保存的来源会过滤。过滤数量写入结果，原始账本继续保留，不宣称这些长消息也已完成语义整理。模型输入 JSON 上限 14000 字符，最多提议 4 条，每条最多 4 个原文来源。

默认全实例每小时最多 2 次、滚动 24 小时最多 12 次模型请求，输出每次最多 1500 tokens。DeepSeek thinking 关闭，只有 JSON 提取，没有搜索、工具、SQL、shell 或任意网络目标。后台沿用本 bot 的独立 model.env 和策略中的模型，当前为 deepseek-flash；不读取原官方 bot 的密钥。请求参数依据 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 和 [Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。

预算在请求前事务预留，失败与崩溃中的请求也占额度；全局额度不会因进程重启而清零。租约 90 秒、每 20 秒心跳，单次模型超时 45 秒；任务最多 3 次失败尝试，额度等待或暂停不耗尽失败重试。模型回答先记录用量，再校验并保存决策；决策保存后才写记忆。逐条写入使用稳定操作键和固定结构，崩溃重放不重新调用模型，也不新增重复 revision。

JSON 非法、空返回和截断都不会绕过结构校验。已发生调用的用量仍入账，未能取得用量的响应明确标为 unavailable；完全失去响应的请求保留未结算预留数，平台账单仍是最终依据。

## 数据、遗忘与删除

新增三张表：

| 表 | 内容 |
|---|---|
| life_memory_cursors | 用户在当前会话已安排处理到的事件序号 |
| life_memory_tasks | 有界来源、锚点、隐私 epoch、租约、固定决策和处理结果 |
| life_memory_calls | 跨重启的请求预算预留、已报告 tokens 和失败类别 |

life_conversations 增加 memory_epoch 与 memory_floor_seq。修改/遗忘记忆时，在相关会话推进隐私边界；共享人物记忆会传播到该人物关联的会话。旧整理任务即使正在等待模型，也无法随后写回；旧消息也不会被重新排成另一任务，以改写措辞复活被撤销资料。此做法保守地跳过该范围全部较早未整理消息，而不是尝试语义识别每一种遗忘表达。

worker 与 MemoryStore 的短事务共用隐私锁，网络请求不持锁。暂停记忆写入、暂停全 bot 或单独暂停整理都会阻止新后台调用和写入；运行中的合法决策可以保存，恢复后继续。白名单移除后也不能继续应用相应结果。

范围导出增加任务和游标。物理删除要求适配器和 worker 都已停止、锁已释放且没有运行租约；清理任务决策、人物游标和来源记忆，并使关联范围的待处理任务失效。没有聊天内容或账号字段的预算/用量元数据保留，以免删群重置成本限制；已发送的 QQ 消息、原始备份和模型服务端副本仍不随本地逻辑遗忘撤回。

## 管理

首次安装先停止适配器、备份、执行完整迁移，再初始化：

```sh
scripts/init-consolidation
# 在私有 data/config/consolidation.json 中将 enabled 改为 true。
# 安装 deploy/napcat-memory.service.example，替换工作空间路径；使用项目 Node。
scripts/memory-worker start
scripts/memory-worker status
scripts/life-admin consolidation-status
scripts/life-admin consolidation-pause
scripts/life-admin consolidation-resume
scripts/life-admin usage
```

example 默认关闭；本机配置另行启用，实际群号和账号仍只从忽略的 adapter.json 读取。关闭功能用 consolidation-pause 或停止 worker 即可，不需要降级数据库。修改模型密钥后需重启 worker，让它重新加载独立 model.env。

usage 按 purpose=chat / memory_consolidation 分组。后台调用的纯用量事件保存在 __admin__，不包含聊天正文，因此按某一 conversation 筛选 usage 不包含后台调用。consolidation-status 展示滚动 24 小时预留与完成数；health 文件展示当前进程状态。与 QQ 断线恢复独立：它能处理已经入库的发言，不能补齐 QQ 离线期间未收到的消息。

## 验证

- 141 项后端及适配器检查通过（Life Core 102、适配器 39），包括真实 PostgreSQL。新增覆盖多句普通自述、推断/举例/问题/隐私候选、伪造证据与身份、scope、游标批次、无 QQ 投递、崩溃重放、租约接管/三次失败、小时与日预算、暂停中断、跨群遗忘时的旧任务、物理删除传播和非空 schema 4 升级不回溯旧消息。
- 一次真实模型 API 的隔离验收通过：普通聊天实际生成 1 条共享事实和 1 条候选；写入后模拟中断，再用存储决策恢复，API 总调用仍为 1。相同人物在另一模拟群正确检索，其他人物隔离，新短期上下文保留长期记忆。
- 非空 schema 5 备份实际恢复：2 条记忆、2 个 revision、3 条 evidence、1 个整理任务、1 个调用预留、2 个人物；恢复后运行角色权限正常。API 报告 651 输入、293 输出、合计 944 tokens。它是隔离测试用量，不进入生产数据库 usage，不是金额账单。
- 验收不向真实 QQ 群投递；证据在忽略的 evidence/consolidation-runtime.json。

```sh
scripts/check-project
# 只在本机加载专用 bot model.env；此验收产生一次真实 API 用量。
set -a
. data/config/model.env
set +a
node scripts/verify-consolidation-runtime.mjs
```

后续仍需真实群聊验收与更大样本质量评估。向量检索、自动候选晋升、关系卡、完整 Reflection/Self、衰减和主动跟进尚未交付。

## 本机部署与待验收（2026-10-21 00:43）

已停适配器后备份，并实际恢复核验 schema 4 非空备份，再迁移到 schema 5、启用 napcat-memory.service 的 user default target、重启适配器。worker 为 idle、QQ/OneBot 与数据库在线；未开启 linger 或修改 QQ 安全设置。核验 worker 进程中的模型密钥与本 bot 独立 model.env 一致，只输出比较结果，没有暴露密钥。

部署保留原来的 1 条记忆、3 个 revision、4 条 evidence；4 条人物/会话游标以历史事件为基线，初始任务及后台调用为 0。迁移后的实际非空备份也已在独立数据库恢复，schema 5、记忆、游标和原有数据一致。部署证据为忽略的 evidence/consolidation-deployment-20261021.json。

博士已明确选择稍后进行真实群聊验收；本次没有代发测试消息或将合成偏好写入正式库。后续在“测试群”群分开发三条愿意长期保留的真实日常消息，不用“记住”，即可核对来源 writer、memory.consolidated、后台用量及下一轮召回。若前台 agent 已先保存，同步核对后台去重结果，不把前台写入误认作后台提取。
