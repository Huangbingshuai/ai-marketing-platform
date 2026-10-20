# Web 前端规则

适用于 `apps/web/**`。开始工作前还必须阅读根 `AGENTS.md` 和对应工作流指南。

## 职责边界

- Web 只负责页面展示、交互、前端路由、临时 UI 状态和 API 调用。
- 不在前端实现数据库持久化、任务编排、模型调用或对象存储直传凭证生成。
- 跨页面项目上下文必须复用统一 Project Store；禁止为单个工作流建立另一套项目或资产库。
- 服务端实体、状态枚举和请求响应类型优先从 `packages/contracts` 使用或生成，不手写漂移副本。

## 页面与状态

- 工作流节点页面必须明确处理加载、空数据、错误、待更新、运行中、部分失败和完成状态。
- `WorkflowNodeState` 用于恢复编辑界面；已确认的 `WorkingArtifact` 由 API 返回。不能把输入框每次变更都当成正式 revision。
- 项目或工作流运行切换时，清理或重新加载作用域状态，禁止串用上一项目的数据。
- 轮询、订阅和定时器在页面卸载时必须释放；重复进入页面不得创建重复任务。
- 后端持久化状态是任务进度、待更新、告警和终态的唯一事实源；刷新后应能恢复轮询。
- 面向用户的节点详情不得暴露 storage key、MIME、内部模型名、Prompt 原文、原始 JSON 或技术堆栈。
- 告警与错误使用去重后的安全中文文案，不在拓扑卡、来源卡和详情区重复堆叠同一原因。
- 新增弹窗支持键盘操作、ESC 关闭和焦点恢复。

## 共享组件与复用边界

- 复用前按职责查找：基础控件看 `packages/ui/src/`；项目、文件和工作流通用能力看 `apps/web/src/platform/`；只服务单条流程的能力放在 `apps/web/src/workflows/<workflow>/shared/`。
- 常用共享组件入口：`WorkflowNodeFooter.vue`、`WorkflowRunProgress.vue` 位于 `packages/ui/src/`；工作流级组件位于 `apps/web/src/platform/workflow/components/`，包括 `WorkflowNodeEditActions.vue`、`WorkflowEditingBanner.vue`、`WorkflowExecutionGraphDialog.vue`、`WorkflowSellingPointsEditor.vue`、`WorkflowVideoRenderSettings.vue`；资料导入组件位于 `apps/web/src/platform/file/components/`。
- 不把“参考效果类”当作实现说明。描述复用时标注组件名或路径，以及它负责的交互；若只是外观相似，先核对状态、数据契约、提交点和键盘行为是否一致。
- `apps/web/src/workflows/effect/` 中的页面、Store、节点状态与样式默认是效果类专属。`apps/web/src/workflows/effect/source-import/components/EffectWorkflowCanvas.vue`、`EffectWorkflowBranchTree.vue` 也承载流程画布/分支语义；跨流程使用前须核对输入契约和导航行为，不能借用效果类业务状态。
- 多个流程确有相同交互时，提取共享的展示与交互部分；业务字段、任务状态、API、revision 和分支规则仍由各自工作流维护。不要复制组件，也不要为追求通用而合并不同语义。
- 组件目录或所有权变化时同步更新此索引。工作流指南记录具体调用和流程差异，不重复抄写通用复用原则。

## 原型还原

- 正式 UI 必须优先复用现有设计令牌、布局组件和交互模式。
- 基于原型开发时，必须阅读 `docs/development/agent-guides/prototypes.md` 并执行 `$reproduce-prototype-ui`。
- 原型是视觉与交互基线，不是可直接复制进生产环境的单 HTML。不得把原型里的内联 Mock、全局变量和运行时网络依赖直接搬入正式工程。
- 未经确认不得自行改版、换色、删除信息层级或把节点重做成另一种产品结构。

## 验证

- 至少执行相关单测、TypeScript 类型检查和构建检查。
- 交互或样式变更必须浏览器验证主要流程，以及 1920、1440、窄屏中的相关布局。
- 验证加载、空、错误、成功、禁用和待更新状态；不得只验证默认 Mock 首屏。
