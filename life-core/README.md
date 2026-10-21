# QQBot Life Core：事件账本基础层

独立 TypeScript 包 `@local/qqbot-life`。当前提供 PostgreSQL 事件账本、持久任务队列、Outbox、媒体引用、预算、管理命令及本地持久 spool，不依赖 QQ、NapCat 或 DSH。

归档版还包括有证据的事实记忆与词法检索、人物偏好、后台整理、群语言、反馈习惯和表情库。完整关系画像、Self Model、周期性反思和无入站触发的自主发言调度未完成。通道适配器通过公开 API 使用此包。

```text
authorized channel event → fsync spool → transaction(events + jobs)
                                      ↓ leased worker
                           normalized input → runtime/tools
                                      ↓
                          transaction(output + outbox)
                                      ↓
                    dispatching → confirmed / failed / unknown
```

队列按 conversation 串行领取，使用租约、心跳和 owner 校验；其他 conversation 可以由其他 worker 领取。当前 OneBot 部署只使用一个 worker。模型计算采用最多三次的恢复处理；已准备好的输出不会重新生成。发送发生前写入 `dispatching`，发送成功回执提交后为 `confirmed`；超时或进程消失时为 `unknown`，不会自动重发。

`confirmed` 代表通道 API 已接受，人工可见性另行验收。它不承诺 exactly-once，也不能补回适配器停机期间没有经 WebSocket 收到的 QQ 消息。

`life_app` 可以 INSERT/SELECT 事件，不能 UPDATE/DELETE/TRUNCATE 事件或创建 schema 对象。独立 `life_admin` 凭据只供本地迁移、导出和删除。当前命名空间、鉴权及 allowed peer 校验由可信适配器执行；数据库角色不是多租户行级权限系统。模型没有数据库访问工具。

## 开发

Node.js 24+、pnpm 12。先安装并编译 Life Core，再编译适配器：

```sh
pnpm install --ignore-scripts --frozen-lockfile
pnpm build
pnpm check
LIFE_TEST_ADMIN_CONFIG=/ABSOLUTE/WORKSPACE/data/config/life-db-admin.json pnpm test
```

实际 PostgreSQL 测试会创建独立的 `qqbot_life_test_<pid>` 数据库，结束时删除。不会清空运行库。未提供配置时，PostgreSQL 用例明确标记 skipped；完整验收请使用根目录 `scripts/check-project`。

## 管理

通过根目录脚本运行：

```sh
scripts/life-admin status
scripts/life-admin usage
scripts/life-admin pause
scripts/life-admin resume
scripts/life-admin scope-status --conversation onebot:ACCOUNT:group:GROUP
scripts/life-admin export --conversation onebot:ACCOUNT:group:GROUP --output /PRIVATE/export.json
```

删除必须使用通道侧的 `scripts/life-delete`，以同步清理本地 spool、session 和媒体；直接 `admin delete` 只操作数据库。详见 [基础层设计与验收](../docs/LIFE-CORE-FOUNDATION.md)。
