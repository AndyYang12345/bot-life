# DSH OneBot 适配器

独立通道包，连接 NapCat / OneBot 11 和 DSH 0.2.0-rc.2。通道鉴权、消息/引用归一化、媒体下载和 DSH 生命周期在这里；事件账本、队列和持久状态由兄弟包 `@local/qqbot-life` 提供。

## 当前行为

- HTTP/WS token 鉴权、心跳与重连，端点只允许 loopback。
- 群和私聊分别白名单；历史部署在明确授权群启用，私聊关闭。
- 过滤登录账号自身事件；namespace 包含 transport/account/scope/peer。
- 入站写 fsync spool 后进入 PostgreSQL 事务；同会话任务串行，租约恢复，持久预算和 Outbox。
- `get_msg` 在使用前核对群/私聊作用域；无法证明私聊接收者的引用拒绝。
- 自动展开合并转发及内嵌图文，解析分享卡片/B 站链接；QQ 视频下载后最多四帧交给视觉工具，无音轨/字幕；B 站只读 MCP、字幕与抽帧读取另由独立后端提供。
- 可选 attention/questionsOnly，缺省保留 replyAll；旁观消息仍入账并参与后续有界同群上下文与后台记忆整理。
- 图片格式、大小和 URL 校验，hash 命名，原子落地并 fsync；原图和引用分开记录媒体关系。
- 仅允许 `read_image`，每轮最多 8 次，路径同时限制在媒体目录及本轮会话授权图片集合。
- 最近图片索引按账本原始消息顺序生成，引用不当成新图片；回答“上一张图”要求重新看图；`/new` 后不回灌旧范围图片。
- 完整轮次后显式 flush DSH session，再准备回复 Outbox；不向 QQ 发送工具过程或推理过程。
- 独立模型 API key 从私有文件加载；每个模型步骤的已报告 token 用量进入账本，未提供用量的响应明确标记。
- `/bot-ping /bot-status /bot-help`；管理员 `/new /reset /clear /bot-pause /bot-resume`。

只输出文字，每轮最多 6000 字符、每块 2000。语音、视频发送、文件发送、模型切换和交互卡片未移植。长期记忆由 Life Core 提供；完整反思和自我模型未完成。边界与验收见 [共享内容与注意力](../docs/SHARED-CONTENT-ATTENTION.md)。

## 开发

先编译兄弟 Life Core 包，然后：

```sh
pnpm install --ignore-scripts --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

根目录 `scripts/check-project` 会同时检查两个包并运行真实 PostgreSQL 验收。

`client.ts` 连接 OneBot；`inbound.ts` 归一化；`media.ts` 下载；`safety.ts` 管工具边界；`journal.ts` 转换通道事件；`timeline.ts` 构造图片事实索引；`state.ts` 只读迁移旧版 JSON；`index.ts` 编排 DSH 和 Life Core。

## 运行隔离

运行策略在 `data/config/adapter.json`；DSH_HOME 为 `data/dsh-home`，假 HOME 为 `data/home`，cwd 为 `workspace`，媒体在 `workspace/media`。源码与数据库均不开放给 QQ 模型工具。当前仍以本机用户运行，不等同独立 OS 用户沙盒。

唯一入口是根目录 `scripts/run-onebot`，通过 user service `napcat-onebot.service` 启停，flock 阻止重复实例。模型密钥从私有文件加载，官方 QQ 的 AppID/Secret 在 exec 前移除。

首次迁移只保留旧 seen/session/暂停/预算，不回填历史。模型生成中断会建立新 session 重算当前任务；已准备输出直接从 Outbox 恢复。发送状态 unknown 不自动重试，confirmed 仅代表平台 API 接受。完整语义、管理与验收见 [基础层说明](../docs/LIFE-CORE-FOUNDATION.md)。

后续测试直接在 Codex 聊天协作；cc-connect 保持暂停，不再通过飞书请求人工操作。
