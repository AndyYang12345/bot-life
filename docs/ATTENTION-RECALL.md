> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# 自动称呼学习与本地语义注意力

第一版将群内称呼、字面量匹配和真实中文句向量组合起来。基础冷却仍是 20 秒；已确认呼唤直接进入回答，模糊提及或语义接续只获得额外判定机会，不直接强迫发言。它不会微调模型权重，也没有把全部近期聊天总结成一个“语义核”。

## 消息路径

1. 现有 @、引用机器人、明确习惯反馈等通道优先。@其他人时不因称呼或向量命中插入对话。
2. 从本条真人顶层文字匹配真实名字与本群已启用别名。称呼单独成句、句首称呼加呼唤/请求语气可直接进入回答，不调用判定模型；“她刚才说了什么”等谈论形式只交给判定器。
3. 普通文本被冷却挡住时，在本机编码新消息。与预编码的少量呼唤/追问正例、无需接话的负例，以及两分钟内自己最近两段已送达回复比较余弦相似度。正例分数 ≥0.64 且高于负例 ≥0.10，或近期回复分数 ≥0.70 且高于负例 ≥0.10，才提出 semantic 唤醒信号。这些是首版可配置门槛，不是概率或普遍最优值。
4. 模糊提及与语义匹配在冷却期额外唤醒判定器，每群滚动一小时最多 6 次，仍受原有判定/回答共享额度限制。明确称呼不消耗这 6 次唤醒额度，但正常回答额度仍适用。没有命中仍走原有冷却/判定路径。
5. 判定器读取同群最近 8 条入站、自己最近 2 段已确认回复及时间、已验证称呼、有效本人习惯和原有群语言用法。相似度只是辅助资料，群友间闲聊可以继续 observe。工具、网页、正式回复的预算保持原有检查。

转发、卡片、图片里的称呼不会用于字面量唤醒或称呼学习；引用旁真人自己键入的文字可以作为普通输入。初版匹配语法由程序提供，后台 AI 学习的是称呼字面量；尚未自动创造任意正则或新的匹配算法。短句、否定、指代仍可能误判，需要真实群样本继续评估。

## 自动积累与配置

schema 9 增加 life_attention_aliases、life_attention_evidence、life_attention_revisions 和 attention_floor_seq。后台从同群近 7 天、已处理消息中选最多 20 条短真人文本，附上顶层 @/引用是否确实指向机器人；不读取别群、机器人输出、嵌套转发或敏感/拒绝学习内容。

复用原有 consolidation 的同一次请求，AI 最多提出 3 个有原文证据的别名。程序重新核对来源，只接受 2 至 16 字的字面量，过滤通用称呼和正则片段。至少 3 条不同消息、置信度 ≥0.85，并至少 1 条明确指向机器人，且有 2 位说话者或 2 条明确指向证据，才能启用。纯复读同一事件不堆高支持数；一条猜测只能成为候选。已有证据不足 3 条或 14 天未再使用的别名不注入。

数据库保存依据和不可变版本。每个允许群在处理普通文本时按库中有效值生成私有文件：

`data/adapter/attention/<会话键 SHA-256>.json`

文件以 600 权限原子替换，包含真实名字、已启用别名和版本，不包含原始聊天或群号；它是派生配置快照，数据库是权威来源。修改数据库后下一条消息生效，手改该文件不会绕过服务校验。/new 和服务重启不会删除称呼。

```sh
scripts/life-admin attention-list --conversation onebot:ACCOUNT:group:GROUP
scripts/life-admin attention-suppress --conversation onebot:ACCOUNT:group:GROUP --alias-id UUID
scripts/life-admin attention-reset --conversation onebot:ACCOUNT:group:GROUP
scripts/life-admin attention-pause
scripts/life-admin attention-resume
scripts/life-admin attention-bootstrap --conversation onebot:ACCOUNT:group:GROUP
```

pause 停止新学习，已有称呼仍可用；suppress 阻止该称呼被重建；reset 清本群称呼并推进学习水位，旧消息不会立刻重建。bootstrap 只提交有界学习快照，不重放个人事实、不发 QQ 消息，仍共用后台每小时/每日预算。export、delete 和数据库备份包含新表；scripts/life-delete 同时清本群派生 JSON，删除时仍需停服务并暂停。其他 DSH/媒体清理沿用原有流程。

## 本地 embedding 与 GPU

使用 FastEmbed 0.9.0、BAAI/bge-small-zh-v1.5 的 512 维 ONNX 模型。[FastEmbed 模型清单](https://qdrant.github.io/fastembed/examples/Supported_Models/)、[模型作者说明](https://huggingface.co/BAAI/bge-small-zh-v1.5)。权重首次安装下载到私有 data/attention/models；运行时设置离线模式，不通过网络发送聊天，不调用 embedding API。

```sh
scripts/setup-attention        # 独立 CPU venv，适合后续端侧验证
scripts/setup-attention --gpu  # 独立 CUDA venv，不修改全局 Python/CUDA 配置
scripts/verify-attention-embedding --gpu
```

CPU/CUDA 两个虚拟环境互相独立。CUDA 环境包含所需的用户态运行库，依赖主机 NVIDIA 驱动；树莓派改用 CPU 环境，实际硬件兼容性和吞吐仍需实测。配置见 deploy/adapter.example.json 的 attention.recall；CUDA 需要 python 指向 venv-gpu/bin/python，device=cuda。

适配器管理 stdio 子进程生命周期。worker 不继承 API 密钥，使用 CPU 两线程或 CUDA provider，只接受有界编码请求，缓存最多 128 个文本向量；不是通用代码执行或网络服务。预热、不可用、超时会写健康/审计状态，超时不阻塞全部聊天，按原有判定路径处理。GPU 不可用时不会偷偷声称正在使用 GPU，可切换 CPU 配置。

本机 RTX 5060 Laptop / 8 GiB 已实际跑通 CUDA。30 条未缓存合成短句的推理统计：CPU 中位数 2.83 ms / P95 3.93 ms，GPU 中位数 0.65 ms / P95 0.90 ms；CPU RSS 约 207 MiB，CUDA RSS 约 857 MiB、显存约 378 MiB。冷启动约 0.38 / 0.66 秒。数字来自本机此次测试，不是所有硬件或真实群准确率承诺，也不包含 QQ 与云端回答延迟；证据为忽略的 evidence/attention-embedding-benchmark.json。

## 验证边界

真实 PostgreSQL 回归涵盖来源复核、激活门槛、跨群隔离、去重、暂停/租约、停用/重置、导出删除和不可变历史。适配器涵盖呼唤/谈论区分、其他收件人与转发排除、冷却例外、配置和实际离线 ONNX。

`node scripts/verify-shared-runtime.mjs --attention` 使用真实 DSH/模型、独立 PostgreSQL 与模拟 OneBot，验证 AI 实际学出新称呼、称呼在冷却期跳过判定模型、语义召回唤醒实际判定、他人对话保持安静、重启保留和私有配置生成。模型请求沿用独立 bot 密钥，隔离验收不向真实 QQ 发消息；结果记录在 evidence/attention-runtime.json。真实 QQ 验收与部署另行记录。

本次检查合计 262 项通过（core 145、适配器 95、启动器 13、B 站 8、embedding 协议 1）。非空 schema 9 称呼库在独立数据库备份恢复并重施运行角色权限后读取通过，包含 1 个称呼、3 条证据和 1 个版本。

2026-10-21 已正式迁移 schema 8 → 9，原有事实记忆、修订、人物、语言规则、习惯和表情包计数一致；迁移前后备份都完成隔离恢复。三个允许群开启 recall/learning，RTX 5060 的 CUDA worker 已 ready，QQ 未重启。真实群端两条测试均可见：第一条本地称呼直接进入回答、没有判定调用；第二条间隔已超过 20 秒，走普通 AI 判定，不能将它作为真实冷却期语义召回的证明。生产称呼学习已纳入现有待处理任务，滚动 24 小时后台 12 次额度用满，按原预算等待，不伪造正式称呼记录。生产证据保存在忽略的 attention-production-*.json 与 attention-bootstrap.json。
