# 2026-10-15 登录验证

作用域：单账号运营登录页面、统一 API 访问校验、退出和恢复。页面为正式 Vue 实现；浏览器验证通过 Playwright 明确拦截 `/api/` 响应，使用隔离测试账号。没有调用模型、创建业务项目或执行付费任务。

## 浏览器观察

- 1920 × 1080、1440 × 1000、390 × 844、320 × 720 无水平溢出。
- 空表单禁止提交；密码显示/隐藏按钮、回车提交正常；错误后清空密码并恢复隐藏。
- 登录前业务请求数量为 0；成功后显示工作台与退出登录入口；刷新恢复；退出返回登录页。
- 检查初始加载、服务不可用与重新连接。错误状态下不挂载工作台。
- 浏览器的成功/失败响应来自明确的测试拦截，不能证明实际 PostgreSQL 会话持久化或服务器部署已通过。

| 状态       | 截图                                           |
| ---------- | ---------------------------------------------- |
| 桌面 1440  | [login-1440.png](login-1440.png)               |
| 桌面 1920  | [login-1920.png](login-1920.png)               |
| 手机 390   | [login-390.png](login-390.png)                 |
| 错误密码   | [login-error.png](login-error.png)             |
| 加载       | [login-loading.png](login-loading.png)         |
| 服务不可用 | [login-unavailable.png](login-unavailable.png) |

## 已执行验证

- `pnpm db:generate`：通过，生成新会话表的 Prisma 客户端。
- `pnpm typecheck:workspaces`：Contracts、UI、API、Web 通过。
- `pnpm build`：API 和 Web 生产构建通过；Web 保留既有大 chunk 提示。
- `pnpm --filter @ai-marketing/api exec vitest run src/platform/auth src/config/environment.spec.ts src/platform/health src/workflows/effect/information-extraction/effect-extraction-worker.guard.spec.ts src/workflows/effect/prompt-generation/effect-prompt-worker.guard.spec.ts src/workflows/effect/segment-render/effect-segment-render-worker.guard.spec.ts --maxWorkers=1`：7 个文件，27 项通过。
- `pnpm --filter @ai-marketing/web exec vitest run src/api/http-client.spec.ts --maxWorkers=1`：25 项通过，含登录过期通知与旧请求迟到隔离。
- `pnpm --filter @ai-marketing/contracts test`：21 个文件，253 项通过。
- 本次变更的 35 个代码文件使用项目 ESLint 规则检查：0 错误、0 警告。运行时显式指定工作区 `tsconfigRootDir`，规避本机临时目录中的额外配置。
- `git diff --check`：通过。

## 限制与未完成的环境验证

- `pnpm test` 被未修改的 `packages/ui/src/ParameterAdjustList.spec.ts` 阻断：断言使用 LF 字面量，而本机组件为 CRLF。未把完整测试记为通过。
- `pnpm lint` 扫描到本机历史临时目录与本地存储脚本，遇到多个 `tsconfigRootDir` 候选；因此采用上述限定文件检查。未修改既有工具配置或清理用户目录。
- `prisma migrate status` 返回 P1001：本机 `localhost:5432` 不可连接；Docker 引擎也未运行。新迁移尚未在真实数据库执行，完整 Web/API/数据库登录联调和 HTTPS 反向代理部署仍待目标环境验证。
- 未执行生产发布、付费生成、已有工作流草稿的真实退出保存或 Worker 付费端到端任务。

部署顺序与配置参见[运营测试登录与部署](../../../operator-login.md)。
