# 本地开发与运行指南

## 环境

- 根目录 `.env.example` 只提供安全占位符。开发者复制为被 Git 忽略的 `.env` 后填写本机配置。
- 不要把真实 Ark、Seedance、TOS、MinIO 或内部 Worker Token 写进 Git、测试、截图、Prompt 或日志。

## TOS 存储与 MinIO 迁移

- `STORAGE_DRIVER=tos` 使用已创建的私有普通 TOS 桶；填写 `TOS_ENDPOINT/TOS_REGION/TOS_BUCKET/TOS_ACCESS_KEY_ID/TOS_SECRET_ACCESS_KEY`。本地服务使用 HTTPS 外网地域 Endpoint，原生地址自动转换为 S3 地址；不支持 Bucket 域名、内网地址或跨地域混配。使用仅限该桶的读写授权，不开放公共读写。
- 桶不存在或无权限时明确失败，不自动创建云桶、不回退本地存储。视频、音频与下载仍经 API 和项目权限读取；Worker 不获取 TOS 密钥。
- 旧素材不能通过只修改环境变量完成迁移。在 API 目录执行 `pnpm storage:migrate-tos` 只读盘点；`pnpm storage:migrate-tos --apply --concurrency=4` 同路径复制、计算源 SHA-256 并核对数据库引用。TOS 普通上传校验服务端 ETag 与本地 MD5，分片或无法确认的 ETag 完整下载核验 SHA-256；失败后可用同命令续传。检查点位于被 Git 忽略的 `.local-storage/migrations/`，日志不含凭证或签名地址。
- 迁移期间保持 MinIO 为活动存储。最终暂停写入并补齐增量、全部校验成功后，再切换驱动并重启 API；保留原 MinIO 数据卷。切换后有新文件时，回滚前必须同步 TOS 增量，不能直接切回旧桶。
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
