# 定制类信息提炼前端验收

日期：2026-10-09。范围为第二节点 UI 及效果类共用字段组件，未接入提炼 API/Worker，未触发模型、付费任务、版本发布或外部发布。

## 实际观察

- 正式系统现有项目的定制资料区为空；进入信息提炼能展示五块信息卡和“请先确认导入资料”，所有生成/编辑/下一步操作禁用。真实后端仅恢复/同步导航，未上传或确认资料。
- 正式效果类已确认信息卡使用共用组件，五个基础字段、原值、只读边界和卖点列表正常展示；没有修改产品事实或重跑提炼。
- 在 1920、1440、390 宽度检查正式页面和隔离用例；逐一核对实际 `window.innerWidth` 与页面滚动宽度，页面没有横向溢出。窄屏字段单列，来源弹窗边界与内部滚动宽度均未溢出。
- 隔离用例导入真实 Vue 页面组件，API 全部拦截，不读写真实项目。覆盖来源文档阅读、图片用途、导入/提炼往返、刷新展示、模态框 ESC/Tab/焦点恢复，以及加载、空、排队、运行、失败、部分失败、完成、编辑、待更新和来源差异。
- 受控编辑用例验证字段修改、事实增删、取消恢复、保存事件、风格参考选项和时长差异采用。结果内容是虚构青梅酱资料，保存事件不表示后端提交成功。

## 执行结果

- `pnpm --filter @ai-marketing/web exec vitest run src/workflows/customized src/workflows/effect/information-extraction --maxWorkers=1`：9 文件、71 项通过。
- 本次变更文件 ESLint 通过。
- 浏览器累计 56 项前端断言通过；本次文件 Prettier 和作用域内 `git diff --check` 通过。
- 完整 `pnpm --filter @ai-marketing/web build` 在类型检查阶段被范围外 `src/workflows/effect/shared/effect-template-deletion.spec.ts:13` 阻塞：测试 workspace 缺少 `materials`。没有修改该文件。
- 使用忽略目录中的临时 tsconfig，仅排除上述范围外文件后，其他 Web 源码及测试的 `vue-tsc` 检查通过。`pnpm --filter @ai-marketing/web exec vite build` 独立打包通过，保留既有大分包提醒；不能将此写为完整构建通过。

## 截图

真实页面：[1920](2026-10-09-extraction-formal-1920.jpg)、[1440](2026-10-09-extraction-formal-1440.jpg)、[390](2026-10-09-extraction-formal-390.jpg)。

隔离用例（不是生成结果）：[已确认资料、待接入提炼](2026-10-09-extraction-empty-1440.jpg)、[虚构结果展示](2026-10-09-extraction-result-example-1440.jpg)、[窄屏来源资料](2026-10-09-extraction-sources-390.jpg)。

这些证据不证明多文档 AI 理解、模型质量、工作副本提交、并发或分支更新已实现。
