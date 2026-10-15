# 渲染更新计数与无闪动回归（2026-10-10）

正式 `EffectImportNodePage` 与 `EffectSegmentRenderNodePage`，使用被忽略的 `.tmp/render-update-handoff-qa.html` 拦截全部请求。增加 0.5–1.3 秒读取延迟，模拟 Run/产品/任务 ID 变化；不执行付费任务，不修改业务数据。

只读排查本次业务数据：6 个生成任务，另 1 条素材标记 `MATERIAL_DELETED`，共 7 项更新。进度旧实现仅展示 6 个生成任务，不是遗漏第七个视频。

观察结果：

- 创建为 0/7、0%；移除事务成功后 1/7、14%，明确显示“视频 0/6 · 移除 1”。一个视频完成、另一个视频 39% 时 2/7、34%，不再读取素材池旧完成率。
- 进入编辑、取消编辑、局部更新切入隔离 Run、自动保存返回原分支：标题卸载与整页加载监测均为 0；5 条/页、第 2 页保持不变。
- 旧 revision 响应被丢弃后继续轮询；短暂网络失败后恢复，完成后自动恢复“进入编辑”可操作状态。
- 连续第二轮更新重新从 0/7 创建，再显示本轮 1/7，未借用上一轮 100%。
- 1440、1920 和 390 宽度检查；390 下未发现横向溢出。截图为隔离交互证据，不证明供应商速度、画面质量或真实付费端到端通过。

截图：[创建](creating-1440.png)、[运行](running-1440.png)、[1920](running-1920.png)、[窄屏](running-390.png)、[保存回切](completed-1440.png)。

验证命令及结果：

- `pnpm build:packages`：通过。
- `pnpm --filter @ai-marketing/contracts exec vitest run src/effect-segment-render.spec.ts --maxWorkers=1`：24 通过。
- `pnpm --filter @ai-marketing/web exec vitest run src/workflows/effect/segment-render src/workflows/effect/shared/effect-run-refresh.spec.ts --maxWorkers=1`：156 通过。
- `pnpm --filter @ai-marketing/api exec vitest run src/workflows/effect/segment-render --maxWorkers=1`：239 通过，9 个数据库开关测试跳过，不计为通过。
- `uv run --frozen --project workers/seedance-worker pytest workers/seedance-worker/tests`：42 通过。
- Web/API 类型检查、定向 ESLint 与 `git diff --check`：通过。
- Web 生产构建：通过，保留现有大包体积提示。API 使用独立 `.tmp/render-update-handoff-build` 输出执行 `tsc -p tsconfig.build.json`：通过，未覆盖运行目录或重启有活动任务的进程。
- 本地 API 现有批次只读 GET：HTTP 200；该批次已自动提交完成，未发起新生成。未验证新的真实付费生成、数据库并发集成或跨分支付费端到端。
