# 效果类工作流：AI 信息提炼节点

本目录实现效果类工作流第 02 步“AI 信息提炼”的前端页面、状态模型、本地 Mock Service 与单元测试。

## 原型基准

- 业务页面与工作流画布：`references/prototypes/effect/effect-workflow.html`
- 系统外壳与公共容器：`references/prototypes/integrated/system-integrated-demo.html`
- 具体参考区域：效果类工作流画布、第 02 步“AI 信息提炼”、产品信息卡、提炼结果表单、底部节点导航与状态反馈。

正式页面复刻原型的蓝白视觉、卡片层级、尺寸、间距、字体、圆角、按钮层级和提示条。工作流画布允许自由切换六个节点；第 03–06 步仅保留范围占位，不在本模块实现 Prompt、渲染、混剪和导出业务。

## 功能范围

- 接收资料包导入节点提供的单产品或多品类、多产品数据。
- 切换当前产品，各产品独立保存提炼结果、保存状态和处理状态。
- 支持单产品提炼、重新提炼及全部产品批量提炼。
- 展示未生成、生成中、已完成、失败、待更新五种处理状态。
- 提炼并编辑目标人群、营销目标、核心卖点、使用场景、投放渠道、品牌调性和禁用元素。
- 支持保存草稿，切换产品后不会丢失已编辑内容。
- 失败状态展示错误原因，并允许重新提炼。
- 信息提炼页底部的“下一步”按钮仅在当前产品完成提炼后可用；顶部工作流画布不锁定节点，可自由查看其他步骤。
- 全部异步过程由本地 Mock Service 完成，不发起真实网络请求。

## 目录结构

```text
information-extraction/
├─ EffectInfoExtractionNodePage.vue          # 页面结构、表单与交互编排
├─ effect-info-extraction-state.ts            # 状态、结果类型与纯函数
├─ effect-info-extraction-state.spec.ts       # 状态模型单元测试
├─ services/
│  ├─ effect-info-extraction.service.ts       # 可替换 Service 接口与本地 Mock 实现
│  └─ effect-info-extraction.service.spec.ts  # Service 单元测试
└─ README.md
```

工作流入口与画布位于：

- `apps/web/src/workflows/effect/source-import/EffectImportNodePage.vue`
- `apps/web/src/workflows/effect/source-import/components/EffectWorkflowCanvas.vue`

## 状态模型

处理状态定义在 `effect-info-extraction-state.ts`：

| 状态 | 页面含义 |
| --- | --- |
| `NOT_GENERATED` | 尚未生成提炼结果 |
| `PROCESSING` | 本地 Mock 正在执行提炼 |
| `COMPLETED` | 已生成结果，可编辑并进入下一步 |
| `FAILED` | 提炼失败，展示原因并支持重试 |
| `STALE` | 上游资料发生变化，当前结果需要更新 |

草稿保存状态独立于处理状态，包含 `CLEAN`、`DIRTY`、`SAVING`、`SAVED` 和 `SAVE_FAILED`。

每个产品通过以下组合键隔离状态：

```text
projectId:draftId:productId
```

Service 会根据产品名称、品类、SKU、有效视频配置和素材摘要生成来源指纹。上游数据变化后，已完成结果会转为 `STALE`，避免继续把旧结果当作最新结果使用。

## Service 替换约定

页面仅依赖 `EffectInfoExtractionService`，当前注入的是单例 `mockEffectInfoExtractionService`。接口包含：

- `loadWorkspace`：恢复全部产品状态。
- `extractProduct`：提炼或重新提炼单个产品。
- `extractAll`：批量提炼全部产品。
- `saveDraft`：保存当前产品的编辑结果。

后续接入真实后端时，应新增正式 Service 实现并保持上述方法语义，页面组件无需散落网络请求、定时器或固定 Mock 数据。真实请求仍应通过前端 HTTP API 客户端调用 NestJS，禁止前端直接调用模型服务。

## 本地 Mock 规则

- 单产品默认进入未生成状态。
- 批量模式预置已完成、首次失败、待更新等演示状态，覆盖主要验收场景。
- 单次提炼约 900ms，保存草稿约 260ms。
- Mock 结果根据当前产品和有效视频配置生成，不写死在 Vue 组件内。
- Mock 状态保存在当前页面会话的 Service 单例中，不使用浏览器持久化存储。

## 开发与验收

在仓库根目录执行：

```bash
pnpm --filter @ai-marketing/web typecheck
pnpm --filter @ai-marketing/web test
pnpm build:web
```

主要交互验收项：

1. 六个工作流节点均可点击，画布样式与冻结原型一致。
2. 单产品可完成提炼、编辑、保存草稿和重新提炼。
3. 多产品切换后，各产品结果和状态互不串联。
4. 批量提炼能同时更新多个产品，并正确展示失败与重试状态。
5. 修改上游资料后，对应已完成结果标记为待更新。
6. 当前产品未完成时，信息提炼页底部下一步按钮不可用；完成后可进入下一节点。

## 当前边界

- 本模块不修改后端、数据库和共享接口契约。
- 本模块不发起真实网络请求。
- 本模块不实现 Prompt、片段渲染、自动混剪和校验导出业务。
- 本地 Mock 状态在浏览器刷新后会重新初始化；正式持久化由后续后端 Service 承担。
