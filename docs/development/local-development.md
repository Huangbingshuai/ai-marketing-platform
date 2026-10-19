# 本地开发与运行指南

## 环境

- 单账号登录配置、Cookie、反向代理和部署迁移见[运营测试登录与部署](operator-login.md)。启动 API 前必须配置账号密码哈希，不支持免登录回退。

- 根目录 `.env.example` 只提供安全占位符。开发者复制为被 Git 忽略的 `.env` 后填写本机配置。
- 不要把真实 Ark、Seedance、TOS 或内部 Worker Token 写进 Git、测试、截图、Prompt 或日志。

## 对象存储

- `STORAGE_DRIVER=local` 使用本地开发存储；`STORAGE_DRIVER=tos` 通过火山官方 `@volcengine/tos-sdk` 使用已创建的私有普通 TOS 桶，并配置 `TOS_ENDPOINT/TOS_REGION/TOS_BUCKET/TOS_ACCESS_KEY_ID/TOS_SECRET_ACCESS_KEY`。本地服务直连 HTTPS 外网原生地域 Endpoint，不继承桌面 HTTP 代理；历史 S3 地址兼容规范化为原生地址，不支持 Bucket 域名、内网地址或跨地域混配。使用仅限该桶的读写授权，不开放公共读写。
- 桶不存在或无权限时明确失败，不自动创建云桶、不回退本地存储。视频、音频与下载仍经 API 和项目权限读取；Worker 不获取 TOS 密钥。
- 效果类返修在 API 校验原片、项目/Run、版本及 Worker 租约后，签发最长 30 分钟的 TOS GET 地址，替代已过期的供应商地址，无需开放本机 API 公网访问。签名地址只作当前任务临时输入，不写入工程或数据库；是否接受参考输入由供应商最终校验，存储迁移不自动触发付费返修。

## 基础设施

效果类恢复投影默认启用共享 Redis 缓存，`EFFECT_READ_CACHE_TTL_SECONDS=1800`，
`EFFECT_READ_CACHE_MIN_LOAD_MS=0`（所有经审核的投影都允许缓存）。可按实测设置正数门槛，
或用 `EFFECT_READ_CACHE_ENABLED=false` 回退原读路径。每次命中前仍读取 PostgreSQL 依赖版本，
改草稿即换键；任务/返修执行时绕过缓存。文件正文、二进制、签名 URL 不进入该缓存。
修改环境变量后需按本文启动方式重启 API；生产构建不会更新正在运行的进程。

资料包、草稿、产品分页与移除列表、提炼、Prompt、渲染工作区、混剪、成片和效果类确认产物投影
均接入缓存。通用 Run 概览和不限定节点的产物列表继续数据库读取，因为包含混合节点状态或原始资料。

定制类资料导入也复用上述 Redis 连接和 `EFFECT_READ_CACHE_*` 配置，缓存当前 Run 概览、文件引用草稿和版本树；键按 CUSTOMIZED / 实际 Run 隔离。概览仅在包含无历史文字的资料导入草稿时允许缓存，其他节点、历史正文及文件内容仍走原读取链路，每次命中仍以 PostgreSQL 版本核对新鲜度。

定制类信息提炼工作区也接入相同投影缓存，依赖资料包、任务、步骤、结果和资产版本；活动执行绕过缓存，正文和签名 URL 不进入缓存。PostgreSQL 权威版本与确认事务不变。

只读性能采样与实例检查：

```powershell
node apps/api/scripts/measure-effect-read-cache.mjs <projectId> 11
node apps/api/scripts/inspect-effect-read-cache.mjs
```

真实数据库/Redis 的隔离 HTTP 验证（仅创建、清理随机测试项目，不执行生成任务）：

```powershell
$env:EFFECT_CACHE_DATABASE_TEST='1'
pnpm --filter @ai-marketing/api exec vitest run src/platform/cache --maxWorkers=1
```

定制类资料导入的隔离 HTTP / 本地文件验证：

```powershell
$env:CUSTOMIZED_CACHE_DATABASE_TEST='1'
pnpm --filter @ai-marketing/api exec vitest run src/platform/cache/customized-cache.http.spec.ts --maxWorkers=1
```

```powershell
docker compose up -d
```

效果类信息提炼 Worker：

```powershell
docker compose --profile effect-extraction up -d --build effect-extraction-worker
```

- `docling-model-init` 是一次性初始化任务，成功后的 `Exited (0)` 是正常终态。
- `effect-extraction-worker` 是常驻消费者，必须保持运行。
- Playwright Chromium 已并入 `effect-extraction-worker`，不再启动独立电商渲染容器。
- Docling 模型位于 `docling-models` named volume：一次性初始化任务以 root 写入，常驻非 root Worker 在 `/models` 只读挂载。
- Docling 使用 CPU 版 PyTorch；无明确需求不得引入 CUDA、NVIDIA 或 Triton。
- 容器访问宿主机使用 `host.docker.internal`，内部 API 端口跟随 `API_PORT`。

定制类信息提炼使用独立 profile / 服务，共享 Docling 模型卷：

```powershell
docker compose --profile customized-extraction build customized-extraction-worker
docker compose --profile customized-extraction up -d customized-extraction-worker
```

API 与该 Worker 必须设置相同的 `CUSTOMIZED_EXTRACTION_WORKER_TOKEN`。模型名称复用 `ARK_DOCUMENT_MODEL`，重试使用 `CUSTOMIZED_EXTRACTION_MAX_ATTEMPTS=2`；定制类使用 `CUSTOMIZED_EXTRACTION_REASONING_EFFORT=medium`、`CUSTOMIZED_EXTRACTION_AUDIT_REASONING_EFFORT=low`、`CUSTOMIZED_EXTRACTION_DOCUMENT_REASONING_EFFORT=low`、`CUSTOMIZED_EXTRACTION_MODEL_TIMEOUT_SECONDS=300`、`CUSTOMIZED_EXTRACTION_MAX_OUTPUT_TOKENS=16384`、`CUSTOMIZED_EXTRACTION_RETRY_MAX_OUTPUT_TOKENS=32768`，不影响效果类配置，不分析品牌图片。两个提炼镜像的构建上下文均为 `workers/`，通过本地 `shared/extraction-runtime` 依赖共享解析底座。构建镜像不代表已替换现有容器；更新前核实无活动任务。启动消费者会处理待执行队列，不应把真实模型运行作为无付费验证。

无付费定制提炼接口验证（随机隔离项目、禁用后台分发）：

```powershell
$env:CUSTOMIZED_EXTRACTION_DATABASE_TEST='1'
$env:CUSTOMIZED_EXTRACTION_HTTP_TEST='1'
pnpm --filter @ai-marketing/api exec vitest run src/workflows/customized/information-extraction --maxWorkers=1
```

两类 Python 验证分别在 `workers/effect-extraction` 和 `workers/customized-extraction` 使用各自锁文件运行 pytest / mypy；效果类付费集成标记需排除。真实本地 Docling 验证入口见[定制 Worker](../../workers/customized-extraction/README.md)。

## 定制类分镜 Worker

```powershell
docker compose --profile customized-storyboard build customized-storyboard-worker
docker compose --profile customized-storyboard up -d customized-storyboard-worker
```

独立 Token 为 `CUSTOMIZED_STORYBOARD_WORKER_TOKEN`，API 与 Worker 必须一致。API 将 `CUSTOMIZED_STORYBOARD_CREATIVE_MODEL` 与 `CUSTOMIZED_STORYBOARD_DETAIL_MODEL` 冻结在任务中；默认分别为 `doubao-seed-2-1-pro-260915` 和 `doubao-seed-2-1-turbo-260628`。Worker 只依赖轻量 `shared/ai-runtime`，不安装解析模型或挂载 Docling 卷。并发默认 2，单调用超时 300 秒、最多尝试 2 次；分别用 `CUSTOMIZED_STORYBOARD_CONCURRENCY`、`CUSTOMIZED_STORYBOARD_TIMEOUT_SECONDS`、`CUSTOMIZED_STORYBOARD_MAX_ATTEMPTS` 配置。构建后须在无活动任务时更新容器；启动会消费真实队列。

无付费分支数据库验证（随机项目，测试内禁止 Outbox 发送）：

```powershell
$env:CUSTOMIZED_STORYBOARD_DATABASE_TEST='1'
pnpm --filter @ai-marketing/api exec vitest run src/workflows/customized/storyboard
```

Worker 受控验证在 `workers/customized-storyboard` 执行 `uv sync --frozen`、`uv run pytest`、`uv run mypy src`。运行及故障恢复见[分镜 Worker](../../workers/customized-storyboard/README.md)。

## 定制类资产准备与视频制作 Worker

两个节点分别部署；资产准备不再由视频制作消费者执行。API 与两个 Worker 分别配置 `CUSTOMIZED_ASSETS_WORKER_TOKEN`、`CUSTOMIZED_PRODUCTION_WORKER_TOKEN`，不能互用。配置调整后核对实际运行进程已加载新值；仅在无活动任务时更新对应服务，不因构建成功推断运行配置已更新。

```powershell
docker compose --profile customized-assets --profile customized-production config --quiet
docker compose --profile customized-assets --profile customized-production build customized-assets-worker customized-production-worker
docker compose --profile customized-assets --profile customized-production up -d --no-deps customized-assets-worker customized-production-worker
docker compose --profile customized-assets --profile customized-production ps customized-assets-worker customized-production-worker
```

两者使用各自目录的 Dockerfile 和 uv.lock，复用轻量共享执行依赖。视频制作镜像另安装 FFmpeg，API 环境须提供 ffprobe。资产队列为 `customized.assets.requested`；视频制作队列仍为 `customized.production.requested`，处理分镜、逐镜 Prompt 和逐镜视频。并发、超时和请求次数分别由 `CUSTOMIZED_ASSETS_*` / `CUSTOMIZED_PRODUCTION_*` 配置，默认 2 / 300 秒 / 2 次。启动消费者会消费真实消息；旧队列资产任务由 API Outbox 转交，不重新创建业务任务。

受控测试与启动边界见[资产 Worker](../../workers/customized-assets/README.md)、[视频制作 Worker](../../workers/customized-production/README.md)。素材交付后端尚未实现，暂不启动空消费者。资产图片及逐镜视频已接通。视频制作 Compose 并发为1，渲染使用效果类相同的 Seedance 模型配置；`CUSTOMIZED_VIDEO_RENDER_TIMEOUT_SECONDS` 默认900秒，`SEEDANCE_POLL_INTERVAL_SECONDS` 默认8秒。整片合成及交付未接通。

## 效果类片段渲染 Worker

```powershell
docker compose --profile effect-segment-render build effect-segment-render-worker
docker compose --profile effect-segment-render up -d effect-segment-render-worker
```

代码目录为 `workers/effect-segment-render`，Python 包为 `effect_segment_render`，入口命令为 `effect-segment-render-worker`。从旧服务迁移时，须在没有活动渲染/返修任务时先停止原 `seedance-worker` 容器；新服务不会自动替换旧容器，不得同时运行两个消费者叠加供应商额度。队列、Token 及 `SEEDANCE_*` / `SEGMENT_RENDER_*` 配置保持不变。无付费验证和运行边界见[片段渲染 Worker](../../workers/effect-segment-render/README.md)。

## 服务器部署

独立生产 Compose、运营测试入口、备份及更新方式见[服务器部署说明](server-deployment.md)。本地开发继续使用本指南的开发服务和原有 Compose profile。

## 常规验证

API 的 `dev` 脚本先运行 `apps/api/scripts/dev-api.mjs`。该入口按工作区持有进程互斥，重复启动会复用现有服务；Windows 进程退出时内核释放互斥。请经上述 pnpm 入口启动，不再直接运行 `nest start --watch`。迁移前直接启动的 Nest watcher 会被检查并提示 PID，入口不会自动终止它。停止开发入口会结束它启动的 Nest 与运行进程。

源码热更新仍有短暂重启窗口。共用 JSON GET 对 502/503/504 或断连最多重试 4 次，等待合计 5 秒；取消信号立即停止等待。写操作、普通业务错误和原始文件请求不重试，持续故障仍显示错误。生产环境应由部署进程管理保证服务可用性。

API 的 `pnpm dev:api` / `pnpm --filter @ai-marketing/api dev` 使用 `tsconfig.dev.json`，热更新输出到 `apps/api/dist-dev`；生产构建继续输出到 `apps/api/dist`。这样执行 `pnpm build` 时，Nest 的 `deleteOutDir` 不会删除正在热更新的入口文件。已有 `nest start --watch` 进程须在没有活动任务时重启为上述命令，启动日志/进程命令行应指向 `dist-dev/main`。开发与生产输出均复制资料导入模板资源。

同一工作区只保留一个 API 热更新进程。出现 `EADDRINUSE` 时，检查监听端口及其父进程；失败的旧 watch 也可能在下次源码变更时再次争抢端口。确认没有活动任务后，停止已核实属于当前 API 的重复 watch 及其子进程，再启动一个开发进程。

本地 API 若以 `node dist/main.js` 运行，构建只更新磁盘文件，不会更新已运行进程中的代码。修复后先确认监听 `API_PORT` 的进程启动方式；普通启动须在无活动任务时重启，不能把构建成功视为运行服务已经生效。重启后检查健康接口、进程启动时间及实际业务输入/请求；前端请求拦截与源码单测不能代替服务生效验证。

模板混剪智能包装与智能填充共用原 Worker，但分别控制并发。`TEMPLATE_MIX_PACKAGING_ITEM_CONCURRENCY` 默认 6（最多 8），`TEMPLATE_MIX_PACKAGING_MODEL_CONCURRENCY` 和 `TEMPLATE_MIX_PACKAGING_TTS_CONCURRENCY` 默认各 4；预处理仍最多 2 条，音乐请求保留独立限流。调整包装并发后需要重建并重启原 `effect-template-mix-worker`，并让 API 进程读取相同的条目并发值，页面初始耗时估算才会一致。提高至 8 前先检查真实批次的 429、超时和分项耗时；20 分钟不能仅凭基线估算宣称达成。

包装与素材局部更新使用独立的模型请求配置：`TEMPLATE_MIX_PACKAGING_MODEL_TIMEOUT_SECONDS` 默认 300 秒，`TEMPLATE_MIX_PACKAGING_MODEL_MAX_OUTPUT_TOKENS` 默认 16384。截断响应按需扩大容量，达到上限的多槽位视觉分析继续拆分；不改动智能填充或素材导入配置。局部更新复用包装的有界断点恢复并保留成功步骤，持续失败仍明确报告，不保证供应商始终可用。

效果类 Prompt Worker 默认 `PROMPT_MAX_CONCURRENCY=4`，同一进程共享 AI 并发额度；遇到供应商 429 后降到最多 2 路，现有退避重试继续生效，进程重启恢复配置值。评分输出预算默认 `ARK_PROMPT_EVALUATION_MAX_OUTPUT_TOKENS=8192`，按输入和输出容量动态分组，不截断事实或正文。本地 `.env` 的显式配置优先于默认值；调整配置或 Worker 代码后，应在无进行中任务时重建并重启对应 Worker，不能只重启前端。独立画面修正使用现有候选模型，不更换评分模型。

TypeScript：

API 的 `test` 命令分别运行 `src` 与开发入口的 Vitest 测试、运维脚本的 Node 原生测试；两类运行器不可混用。`pnpm --filter @ai-marketing/api test:scripts` 可单独运行后者，不启动实际生成任务。

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm exec prettier --check .
```

完整门禁：

```powershell
pnpm check
```

效果类提炼 Worker：

```powershell
Set-Location workers/effect-extraction
uv run --frozen pytest
uv run --frozen mypy src tests
```

容器：

```powershell
docker compose --profile effect-extraction config --quiet
docker compose --profile effect-extraction build effect-extraction-worker
```

真实 Docling/Ark 测试必须由显式环境开关启用。真实模型会产生费用，未获授权或缺少本机密钥时不得执行，也不得用跳过项冒充通过。

前端交互回归截图存放到对应工作流的 `docs/workflows/<workflow>/evidence/browser/`，覆盖加载、空态、失败、刷新恢复、项目/产品切换、窄屏、键盘与并发冲突；截图不得包含密钥或敏感业务正文。
