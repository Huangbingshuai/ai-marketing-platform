# 本地开发与运行指南

## 环境

- 根目录 `.env.example` 只提供安全占位符。开发者复制为被 Git 忽略的 `.env` 后填写本机配置。
- 不要把真实 Ark、Seedance、TOS、MinIO 或内部 Worker Token 写进 Git、测试、截图、Prompt 或日志。

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
- Docling 模型位于 `docling-models` named volume，Worker 只读挂载。
- Docling 使用 CPU 版 PyTorch；无明确需求不得引入 CUDA、NVIDIA 或 Triton。
- 容器访问宿主机使用 `host.docker.internal`，内部 API 端口跟随 `API_PORT`。

## 常规验证

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
