> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# 图片用途判断与群内表情库

## 行为

启用后，进入视觉处理的群消息在原来的 DSH 回合中先 read_image，再调用 image_classify，不按扩展名或 QQ 表情标志猜用途。只接受本轮直接图片标识，最多四张；视觉工具必须成功返回图像，失败调用不算已经读图。

| 分类 | 处理 |
|---|---|
| meme | 表达情绪/反应的通用梗图或表情；高置信且适合复用时自动收藏 |
| informational | 照片、数据、图表、聊天截图等；正常读图回答，不进表情库 |
| mixed | 同时包含信息和梗，不自动收藏 |
| uncertain | 看不清或用途不明，不自动收藏 |

收藏需要 confidence ≥0.85、reusable=true、privacy_risk=false。私人照片、资料、针对个人的攻击等要求保守处理；视觉模型仍可能误判，可用管理命令停用。同条消息说“不要收藏/别保存”等会关闭该条收藏资格。闪照、引用/合并转发内图片、视频抽帧不自动纳入。暂不批量回看历史图片，也不自动从互联网搜集表情。

按群独立保存，SHA256 去重。来源第一次分类固定，重试不能把已判为私人照片的图改成收藏图。只收藏 ≤4 MiB 的 PNG/JPEG/GIF/WebP，每群最多 100 个条目、合计 100 MiB；满额停止新收藏，保留已有资料。GIF 保存原文件，分类取决于 read_image 可见画面，不宣称理解完整动画。

## 择机回复

先沿用 attention 判断是否接话。回复回合中，在最多 100 项本群库存中用当前/最近发言与描述、标签、适用场景做有限词面排序，最多给模型八个候选；最终是否合适由模型结合上下文判断。描述与标签只是数据，不能成为系统指令。

选图前再次 read_image 查看实际图片，再调用 meme_reply 登记意图。可只发一图或配简短文字，不合适时不用。每回合最多一张，默认至少间隔五分钟，同图 24 小时不重复。刚收到的图片不会成为本轮回复候选，避免镜像复读。

在 attention 模式下，如果是无文字/引用/转发/失败附件的纯表情消息，全部成功分类为 meme 且模型认为无需回应，可只收藏、保持静默。明确 @bot、回复 bot 或提出具体问题仍正常回应。观察普通文字时，不会仅因库存有表情而强行接话。

图片经过现有 Life Core outbox：短文字和图片共用一个消息块与回执。outbox 只保存表情 ID/hash，不保存任意 URL、路径或 Base64。派发前复核本群归属、启用状态、沙盒、文件头、大小与 SHA256，再以 Base64 图片段传给本机 NapCat，避免容器无法读取宿主路径。发送失败/未知遵循文字的防重复机制，未知回执不自动重发。

协议依据：[OneBot 11 图片消息段](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md)、[群消息发送 API](https://github.com/botuniverse/onebot-11/blob/master/api/public.md)。标准支持 Base64 文件内容；群端送达仍需实际回执及接收端验证。

## 数据、管理与预算

schema 7 新增 life_image_labels（来源事件/hash、不可变分类）和 life_memes（同群条目、标签、使用/避免场景与停用状态）。收藏副本独立放在：

    workspace/media/memes/<SHA256(conversation)>/<SHA256(image)>.<ext>

元数据在 PostgreSQL，图片在本机，均不进 Git。数据库备份不含图片，还需备份 workspace/media。导出包含分类与库存；按群物理删除同时处理数据库记录和该群专用副本，其他群的共享原始 blob 按引用保留。

私有 adapter.json 配置：

    {"memes":{"enabled":true,"cooldownMs":300000}}

缺省关闭；启用需迁移 schema 7 并重启适配器。设 false 并重启即可停用、保留库存。管理端：

    scripts/life-admin meme-list --conversation onebot:ACCOUNT:group:GROUP
    scripts/life-admin meme-suppress --conversation onebot:ACCOUNT:group:GROUP --meme-id UUID
    scripts/life-admin meme-pause
    scripts/life-admin meme-resume

pause 同时停分类、候选与派发；全局 pause/记忆写暂停也阻止这些操作。应用角色只有分类/库存的读取和新增权限，不能改既有分类或撤销管理员停用。管理操作不会清除 QQ、DSH 旧记录或备份。

复用 bot 独立 API key 与原有聊天回合/发送限额，不另设逐图后台模型服务。分类工具、再次看图与后续模型步骤会增加 token 消耗，计入聊天用途，不声称没有额外费用。

## 已验证与待验证

2026-10-21：真实 PostgreSQL 覆盖收藏资格、信息/混合/隐私/不确定图排除、群/来源隔离、租约、幂等、容量、排序、文字配图、纯图片 outbox、未知派发不重发、频率、暂停/停用、不可变权限、导出与删除。适配器检查包括媒体路径/内容校验、必须成功读图才能收藏/选图，以及纯表情静默与直接请求正常回应。

运行 node scripts/verify-shared-runtime.mjs --memes，使用真实 DSH 和独立密钥调用模型，在隔离库及本机模拟 OneBot 验证：庆祝图识别/收藏，报告图为 informational 且不收藏，后续庆祝请求选择库存并只发原图，发送回执确认；非空 schema 7 库备份/恢复成功。测试没有连接真实 QQ、没有把合成图写进正式库。真实 QQ 接收端可见性、日常选图自然度和长期误判率尚待观察。

正式部署已完成：两个允许群开启表情库，仍为 attention 模式，QQ 在线，适配器与记忆 worker 运行。schema 6 → 7 前后个人记忆、证据、版本、人物关联、语言规则及统计数量一致；前后备份均已在独立数据库恢复验证。完整检查通过 193 项。正式库从后续新图片积累，未导入合成测试素材。
