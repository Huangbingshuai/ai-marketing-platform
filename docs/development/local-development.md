# 本地开发与运行指南

## 环境

- 根目录 `.env.example` 只提供安全占位符。开发者复制为被 Git 忽略的 `.env` 后填写本机配置。
- 不要把真实 Ark、Seedance、TOS 或内部 Worker Token 写进 Git、测试、截图、Prompt 或日志。

## 对象存储

- `STORAGE_DRIVER=local` 使用本地开发存储；`STORAGE_DRIVER=tos` 通过火山官方 `@volcengine/tos-sdk` 使用已创建的私有普通 TOS 桶，并配置 `TOS_ENDPOINT/TOS_REGION/TOS_BUCKET/TOS_ACCESS_KEY_ID/TOS_SECRET_ACCESS_KEY`。本地服务直连 HTTPS 外网原生地域 Endpoint，不继承桌面 HTTP 代理；历史 S3 地址兼容规范化为原生地址，不支持 Bucket 域名、内网地址或跨地域混配。使用仅限该桶的读写授权，不开放公共读写。
- 桶不存在或无权限时明确失败，不自动创建云桶、不回退本地存储。视频、音频与下载仍经 API 和项目权限读取；Worker 不获取 TOS 密钥。
- 效果类返修在 API 校验原片、项目/Run、版本及 Worker 租约后，签发最长 30 分钟的 TOS GET 地址，替代已过期的供应商地址，无需开放本机 API 公网访问。签名地址只作当前任务临时输入，不写入工程或数据库；是否接受参考输入由供应商最终校验，存储迁移不自动触发付费返修。

## 基础设施

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

## 常规验证

本地 API 若以 `node dist/main.js` 运行，构建只更新磁盘文件，不会更新已运行进程中的代码。修复后先确认监听 `API_PORT` 的进程启动方式；普通启动须在无活动任务时重启，不能把构建成功视为运行服务已经生效。重启后检查健康接口、进程启动时间及实际业务输入/请求；前端请求拦截与源码单测不能代替服务生效验证。

模板混剪智能包装与智能填充共用原 Worker，但分别控制并发。`TEMPLATE_MIX_PACKAGING_ITEM_CONCURRENCY` 默认 6（最多 8），`TEMPLATE_MIX_PACKAGING_MODEL_CONCURRENCY` 和 `TEMPLATE_MIX_PACKAGING_TTS_CONCURRENCY` 默认各 4；预处理仍最多 2 条，音乐请求保留独立限流。调整包装并发后需要重建并重启原 `effect-template-mix-worker`，并让 API 进程读取相同的条目并发值，页面初始耗时估算才会一致。提高至 8 前先检查真实批次的 429、超时和分项耗时；20 分钟不能仅凭基线估算宣称达成。

效果类 Prompt Worker 默认 `PROMPT_MAX_CONCURRENCY=4`，同一进程共享 AI 并发额度；遇到供应商 429 后降到最多 2 路，现有退避重试继续生效，进程重启恢复配置值。评分输出预算默认 `ARK_PROMPT_EVALUATION_MAX_OUTPUT_TOKENS=8192`，按输入和输出容量动态分组，不截断事实或正文。本地 `.env` 的显式配置优先于默认值；调整配置或 Worker 代码后，应在无进行中任务时重建并重启对应 Worker，不能只重启前端。独立画面修正使用现有候选模型，不更换评分模型。

TypeScript：

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
