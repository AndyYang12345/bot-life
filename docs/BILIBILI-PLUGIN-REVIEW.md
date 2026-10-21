> 归档说明：以下是开发期间的历史设计或阶段记录，不代表当前运行状态。最终范围见 [项目首页](../README.md)。本机路径与群聊名称已替换为示例。

# dsh-bili-scroll 源码评估与接入建议

评估日期：2026-10-21。对象：[c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)，固定提交 eab82bb749bdab1e58723b734011dbb583993785，package.json 为 0.1.19。源码只读检出在忽略的 repos/dsh-bili-scroll，未安装依赖、未加载到 profile、未登录 B 站、未修改运行配置或重启 bot。

## 结论

可借鉴，优先复用只读视频理解后端和工具白名单设计。本项目已有 DSH runtime、B 站链接识别、QQ 转发展开、视频有界抽帧和 outbox，适合把它的 B 站数据获取能力接入当前回合。原项目的定时刷视频、日报、B 站评论/私信属于另一层产品流程，初版接入以群友分享链接后的阅读与总结为主。

评估时只解析 B 站分享卡片/链接元数据。后续已独立实现五工具只读桥接（四个资料工具，加短视频抽帧），部署与实测边界以 [B 站阅读](BILIBILI-READING.md) 为准；本文保留评估时的源码结论。

## 能力与可借鉴部分

| 部分 | 实际源码行为 | 本项目用途 |
|---|---|---|
| vendor/bilibili-mcp/mcp_server.py | Python FastMCP，基于 bilibili-api-python，声明 27 个工具 | 固定四个只读工具：bili_search、bili_video_info、bili_subtitle、bili_comments |
| lib/mcp.mjs | Node 起 Python stdio 子进程，JSON-RPC initialize/tools-call，子进程退出时拒绝待处理请求 | 可参考桥接结构，补输出限制、取消、超时终止和重启管理 |
| lib/login.mjs | 扫码登录，凭据保存本机插件目录 | 管理端扫码，独立 600 文件、原子写入，不把登录工具开放给群友 |
| lib/asr.py | yt-dlp 下载音轨，faster-whisper 在 CPU/int8 转写 | 无字幕时的可选补充；封装为服务，不向 QQ agent 开放 shell |
| headless overlay | BILI_MCP_TOOLS 明确注册允许的工具 | 保留后端注册白名单，再加当前 agent 的工具放行和调用限额 |
| 日报/判重/失败记录 | 文本报告、跳过无正文内容、区分失败与空数据 | 迁入现有 ledger/cache，用来源与错误码记录，避免报告文件成为事实库 |

源码依据：[MCP 服务](https://github.com/c1overzz/dsh-bili-scroll/blob/eab82bb749bdab1e58723b734011dbb583993785/vendor/bilibili-mcp/mcp_server.py)、[DSH 接入](https://github.com/c1overzz/dsh-bili-scroll/blob/eab82bb749bdab1e58723b734011dbb583993785/index.js)、[ASR](https://github.com/c1overzz/dsh-bili-scroll/blob/eab82bb749bdab1e58723b734011dbb583993785/lib/asr.py)。

## 内容理解边界

字幕函数按视频 cid 获取字幕，优先中文，最终只输出合并后的文本。当前实现选的是主 cid 或第一分 P，没有让调用者指定分 P，也没有保留各句时间戳。多分 P、长视频分段检索、准确引用需扩展输入与返回格式，不能默认总结完整合集。

ASR 只理解音轨；无声视频、烧在画面的硬字幕、动作演示仍可能读不到。原项目没有完整视觉观看链路。后续可组合本项目的 FFmpeg 抽帧、read_image、字幕/ASR，分别标明实际读到的文本、抽样时间点和未读取部分。现有 QQ 视频下载器只信任 QQ CDN，接 B 站时需要另做视频地址解析与域名验证，不能简单把任意 B 站 URL 塞进原下载器。

搜索函数不强制读取凭证；字幕、视频详情和评论通过 get_cred 要求本地 B 站凭证。依赖声明为 Python 3.10+、bilibili-api-python>=17.4.1,<18、aiohttp>=3.9.0、mcp>=1,<2、qrcode[pil]>=8；ASR 另需 yt-dlp、faster-whisper 与模型。原字幕服务偏网络 IO，Whisper 会带来本地 CPU/内存/磁盘开销，树莓派部署可将 ASR 单独放到其他主机。

## 接入前需调整

1. **工具作用域**：现有 onebot profile 由 dsh-base + 本地 adapter 组成，QQ agent restrict 仅放行全局 read_image，并在当前 agent 内注册记忆/表情工具。全局安装 B 站插件不会自动把其工具开放给 QQ。应在同一 agent 内注册受控 B 站包装器，绑定当前 job、allowlist 和用量审计。
2. **宿主差异**：插件声明依赖 webServer/tools/settings，并附带 Web 设置页；当前 onebot profile 未加入 web UI bundle。版本号满足 engines 只是必要条件，完整插件的激活/自动 headless 路径仍需隔离运行验收。直接复用只读服务更适合现有无界面部署。
3. **后端权限默认值**：Python 服务未设置 BILI_MCP_TOOLS 时开放全部工具，包含评论、私信、动态、上传。接入需显式只读白名单，空配置应拒绝启动；不能只在提示词里写“只读”。宿主 bili_reply 的 force 参数也不能用作 QQ 群内授权凭据，初版不注册写工具。
4. **环境与凭据隔离**：原 MCP 客户端继承整个 process.env。我们的子进程应使用最小环境，不继承 bot 模型 API key；登录 cookie 只归 B 站服务使用。JS saveCredential 直接 writeFile，未显式 600/原子写，复用时应补上。
5. **有界读取**：原字幕下载直接请求 API 返回的 URL，没有本项目要求的显式域名/逐次重定向/响应大小约束；MCP stdout 缓冲也没有长度上限。需加严格 BV/分 P 输入、短链接解析、允许域名、超时与输出截断，并把受限/无字幕/失败作为不同状态。
6. **后续 ASR**：原脚本可接 URL/本地路径，并由 headless 提示词要求执行命令；QQ agent 不应获得此能力。服务只接受经过验证的 BV/分 P，固定下载与转写命令，限制时长、大小、并发和模型大小；失败时降级字幕/元数据，不编造视频内容。

这些是基于实际源码与本地适配器的工程判断，没有据此断言上游所有部署都不可用，也没有验证 B 站当前风控、字幕可用率或扫码后兼容性。

## 建议开发顺序

1. 独立 Python 环境/服务与私有扫码入口；只读 MCP 工具列表验收，确认写工具不存在，凭据不会进入模型上下文和日志。
2. 同群链接/BV/b23 短链 → 验证解析 → 视频详情与所选分 P 字幕 → 有界缓存 → DSH 总结 → 原 outbox。先验证单视频、无字幕、失效链接、登录过期和 API 拒绝。
3. 增加主动搜索与少量评论读取，仍由现有注意力、调用限额和审计控制；评论不进入发送者个人记忆。
4. 按需增加后台 ASR 与画面抽样，最后再做有预算的自主浏览与推荐任务。结果返回现有 QQ 通道；B 站写操作另行授权与实现。

## 许可与验证状态

仓库及 vendored bilibili-mcp 均有 MIT LICENSE，分别保留 c1overzz 与 AGI_Ananas 的版权行和许可正文；若复制源码到本项目，需附相应 LICENSE/NOTICE，不能只拷功能文件。[上游许可说明](https://github.com/c1overzz/dsh-bili-scroll/blob/eab82bb749bdab1e58723b734011dbb583993785/NOTICE.md)。

已完成源码检出、固定提交记录、主模块/MCP 客户端 JavaScript 语法检查、两个 Python 文件 AST 解析、只读工具存在性和当前 profile/guard 对照。未执行插件自检脚本（它会加载插件并启动其 apply）、未安装依赖、未跑真实 B 站接口、未改生产配置。因此结论是方案可借鉴、集成路径明确；尚不是部署完成或真实视频验收通过。
