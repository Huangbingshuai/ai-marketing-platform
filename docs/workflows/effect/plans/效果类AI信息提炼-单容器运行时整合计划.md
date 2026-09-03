# 效果类 AI 信息提炼单容器运行时整合计划

## 状态

已完成（2026-09-03）。

## 目标

将公开电商商品页的 Playwright 动态渲染能力从独立 `commerce-renderer` 容器并入 `effect-extraction-worker`，使效果类“AI 信息提炼”节点只对应一个常驻业务容器。

## 边界

- 不修改资料导入工作副本、提炼结果契约、人工确认边界或下游 Prompt 消费关系。
- COMMERCE 分支仍然先执行静态抓取，仅在页面为 JavaScript 空壳时使用浏览器渲染。
- 保留公网 URL、重定向和子请求的 SSRF 校验，继续禁止 Cookie、下载、Service Worker、WebSocket、图片、视频和字体加载。
- 浏览器在非 root Worker 启动时初始化、Worker 停止时关闭；初始化失败必须阻止 Worker 消费任务。
- 删除容器间 HTTP、Bearer Token、内部 8080 端口和独立健康检查，不在同一容器中启动第二个 HTTP 进程。
- 保留渲染并发数、总超时、DOM 大小和动态内容等待时间配置。

## 实施步骤

1. 把 Playwright 渲染器作为 `effect-extraction` 的进程内适配器，并接入 Worker 生命周期。
2. 将 Playwright/Chromium 安装进提炼 Worker 镜像，给该容器配置 `init` 与共享内存。
3. 删除 Compose 的独立 `commerce-renderer` 服务及 URL/Token 配置。
4. 迁移渲染安全和资源拦截测试，删除不再存在的 HTTP 服务测试与独立 Worker 目录。
5. 更新环境变量示例、根 README、Worker README、本地开发说明和节点实施记录。

## 验收

- Compose 配置中只保留一个 `effect-extraction-worker` 业务容器。
- Worker 启动日志确认 Chromium 初始化成功并开始消费提炼队列。
- 静态电商抓取、动态渲染兜底、SSRF 拒绝、资源拦截、超时和 DOM 上限测试通过。
- Worker pytest、mypy、Ruff、Compose 配置检查、镜像构建和 `git diff --check` 通过。
- 不触碰当前工作区中与 Prompt 生成相关的并行修改。

## 实际结果

- Compose 已删除独立 `commerce-renderer` 服务；运行态仅保留一个常驻的 `effect-extraction-worker` 业务容器。`docling-model-init` 仍是启动前下载模型的一次性初始化任务，不消费业务队列，也不代表第二个工作流节点。
- Playwright、Chromium、动态页面渲染和资源拦截均在提炼 Worker 进程内运行；不再存在容器间 HTTP、Bearer Token 或内部 8080 端口。
- Worker 与 Chromium 均以非 root 用户 `extraction`（UID 10001）运行；Compose 重建后旧 `ai-marketing-platform-commerce-renderer-1` 容器已被移除。
- `effect-extraction` 全量测试结果为 `105 passed, 5 skipped`；本次变更文件的 Ruff 与 mypy 检查通过；Compose 配置检查及生产镜像构建通过；容器内 Chromium 访问公开测试页返回 HTTP 200。
- Worker 全量 mypy 仍报告 3 个本次修改前已存在的测试文件类型问题，分别位于 `tests/test_provider.py` 和 `tests/test_pipeline_partial.py`，与容器合并无关。
- 本次没有调用付费模型，没有改写提炼 WorkingArtifact，也没有触碰并行开发中的 Prompt 生成文件。
