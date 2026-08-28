# 效果类工作流：AI 信息提炼节点

本目录实现效果类工作流第 02 步“AI 信息提炼”的 Vue 页面、真实 API 客户端、异步任务轮询与前端测试。

## 原型基准

- 业务页面与工作流画布：`references/prototypes/effect/effect-workflow.html`
- 系统外壳与公共容器：`references/prototypes/integrated/system-integrated-demo.html`
- 参考区域：第 02 步、产品信息卡、提炼结果表单、状态反馈和底部节点导航。

页面保留冻结原型的蓝白视觉、卡片层级、内容密度、间距、圆角和按钮层级。第 03–06 步仍不在本模块实现。

## 功能范围

- 从资料包导入节点接收当前项目、草稿和产品列表。
- 产品下拉框只决定当前查看和操作的产品；每次只启动当前产品的提炼任务，不提供批量提炼。
- 通过 NestJS API 加载工作区、启动异步任务、轮询任务进度和保存人工修订，前端不直接调用模型。
- 刷新或重新进入页面时恢复 `QUEUED` / `PROCESSING` 任务并继续轮询。
- 展示未生成、排队中、生成中、已完成、失败和待更新状态，以及当前节点、进度和来源级告警。
- “查看工作流”按 `资料快照 → 四路解析 → 多源融合 → 语义整理 → 标准化与结果保存` 展示真实持久化状态；点击“语义整理”可查看规范主题及被归并的原始表达。
- `STALE` 结果仍可查看和编辑，但必须重新提炼后才能进入下一节点；前端不自行计算来源指纹。
- 完整映射共享契约中的 12 个标准字段，完成后可人工编辑并使用 `expectedRevision` 保存。
- AI 标准化仍按核心卖点 3 项、次要卖点/背书 6 项、痛点/动因/场景 5 项控制生成数量；人工编辑列表统一可补充到 20 项，保存和完成校验不会按模型上限截断。
- 保存遇到 HTTP 409 时保留本地编辑，明确提示版本冲突；只有用户点击“加载最新结果”才用服务端版本替换本地内容。

## 目录结构

```text
information-extraction/
├─ EffectInfoExtractionNodePage.vue
├─ effect-info-extraction-state.ts
├─ effect-info-extraction-layout.spec.ts
├─ effect-info-extraction-state.spec.ts
├─ api/
│  ├─ effect-info-extraction.api.ts
│  └─ effect-info-extraction.api.spec.ts
└─ services/
   ├─ effect-info-extraction.service.ts
   └─ effect-info-extraction.service.spec.ts
```

共享请求、响应和标准结果类型来自 `@ai-marketing/contracts` 的 `effect-extraction` 契约。本目录只维护 Vue 需要的草稿保存状态，不复制后端业务契约。

## 状态和请求生命周期

| 状态            | 页面行为                               |
| --------------- | -------------------------------------- |
| `NOT_GENERATED` | 字段为空且只读，可启动提炼             |
| `QUEUED`        | 展示排队进度并轮询                     |
| `PROCESSING`    | 展示当前 LangGraph 节点和进度并轮询    |
| `COMPLETED`     | 结果可编辑、保存并进入下一节点         |
| `FAILED`        | 展示后端错误，可重新提炼               |
| `STALE`         | 保留旧结果但锁定下一节点，要求重新提炼 |

组件切换项目、草稿或卸载时会取消工作区请求、保存请求和全部轮询，避免旧响应写入新上下文。来源告警不会把已完成任务改成失败，也不会阻止人工编辑和保存。

## 开发与验收

在仓库根目录执行：

```bash
pnpm --filter @ai-marketing/web typecheck
pnpm --filter @ai-marketing/web test
pnpm build:web
```

主要验收项：

1. 页面结构与冻结原型一致，12 个结果字段完整可见。
2. 页面不存在“全部提炼”，只处理下拉框当前产品。
3. 排队、执行、完成、失败、来源告警和 STALE 状态正确展示。
4. 语义整理节点位于多源融合和标准化之间，节点详情不展示向量、Prompt、Token 或模型标识。
5. 产品切换和刷新后任务、结果与状态不串联，并能恢复轮询。
6. 人工修改可保存；409 冲突不会丢失本地编辑。
7. 只有当前产品处于 `COMPLETED` 时，底部下一步按钮可用。

## 当前边界

- 不实现 Prompt、片段渲染、模板混剪和成片导出。
- 不自动把提炼结果创建为正式项目资产。
- 电商链接能读取时展示安全化商品信息；受登录、验证码或平台风控限制时展示用户可理解的来源告警。
