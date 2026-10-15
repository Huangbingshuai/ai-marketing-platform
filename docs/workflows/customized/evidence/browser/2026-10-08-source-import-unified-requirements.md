# 2026-10-08 定制类统一需求资料导入验收

## 最终需求与实现

按本次用户修订，制作需求与产品资料合并为“需求资料”，视觉参考图片独立、可选。移除需求摘要与全局配置表，页面、校验提示和下载模板使用面向使用者的表述。统一需求可直接填写文字或上传多份文档；不要求提供样片。

定制流程提炼说明改为“制作需求”；项目资产库搜索提示和列名同步使用“项目名称或产品”“产品信息”。业务查询字段和项目数据保持原有兼容。

视频制作需求模板按制作目标、产品资料、呈现与交付要求组织一份文档，未确定项可留空，已有附件无需重复填写。可选参考图片支持产品、人物、场景、风格及其他用途。

效果类和定制类实际共用 `ImportSourceCard`、`ImportDropzone`、`ImportMaterialRow`、`ImportImagePreview`、`ImportContentViewer` 及图片预览状态逻辑。效果类适配器保留其产品身份、受保护的内容路径、业务回调和缩略图复用校验。画布、版本树和编辑交互继续使用既有效果类组件。

schemaVersion 3 合并 v2 两块文字与文档分类，并兼容 v1 需求和约束。读取投影保留原内容和附件版本，不改历史数据库；新旧规范化内容相同，不增加业务 revision 或发布空分支。

## 执行结果

相关测试共 77 项通过：

```powershell
pnpm --filter @ai-marketing/contracts build
pnpm --filter @ai-marketing/contracts test src/customized-import.spec.ts
pnpm --filter @ai-marketing/web test src/workflows/customized src/workflows/effect/source-import/effect-import-image-preview.spec.ts src/workflows/effect/source-import/effect-import-layout.spec.ts
pnpm --filter @ai-marketing/api test src/platform/workflow/customized-branches.spec.ts src/platform/workflow/customized-draft.spec.ts
pnpm --filter @ai-marketing/web typecheck
pnpm --filter @ai-marketing/api typecheck
pnpm --filter @ai-marketing/web build
pnpm --filter @ai-marketing/api build
git diff --check
```

本次改动文件的 ESLint 和 Prettier 检查通过。Web 构建仍提示大于 500 kB 的打包块，构建成功。本次未运行全仓库 `pnpm check`。

正式页面浏览器回归使用完全拦截 API 的隔离测试上下文，分别通过 23 项导入检查和 32 项版本交互检查：两个上传区、旧文字合并、用语、模板下载、图片区类型限制、上传失败重试、自动上传及引用保存、文档/图片阅读、图片用途刷新恢复、移除引用保留原资产，以及 1920/1440/390 布局。版本检查覆盖确认只读、隐藏编辑、取消与保留、两轮变更、失败后重试、同内容不发布分支、历史切换、刷新、版本树缩放/定位和错误恢复。未以拦截响应宣称真实上传端到端已验证。

冻结定制原型与效果原型已在浏览器读取。效果类正式导入组件单独挂载、拦截内容请求回归通过 12 项检查，包括单品/批量上传入口、选择和拖拽回调、受保护的资料阅读路径、图片预览复用、只读禁用及 1440/390 布局。两个正式流程都使用共用组件；统一需求布局是用户此次明确要求的功能调整。

真实 PostgreSQL 事务回滚验证通过 12 项检查：首次提交、重复提交、确认后拒绝直接修改、复用隐藏编辑 Run、旧请求保护、真实 revision 递增、父版本保留、无变化返回原版、取消、历史指针及旧 Run 发布拒绝。测试创建的数据全部回滚，模型调用及对象存储写入均为 0。API 当前运行入口核对为 `dist-dev/main`，健康接口成功。

## 截图

截图均为隔离测试资料，仅用于布局与交互验证。

- [1440 编辑态](2026-10-08-unified-requirements-edit-1440.png)
- [1440 已导入资料](2026-10-08-unified-requirements-files-1440.png)
- [390 已导入资料](2026-10-08-unified-requirements-files-390.png)
- [1920 版本树](2026-10-08-unified-requirements-tree-1920.png)
- [390 版本树](2026-10-08-unified-requirements-tree-390.png)

## 验证边界

没有调用付费模型或供应商接口，没有自动提交 Git。标准化提炼及后续专用生成链路仍未接入，不将导入页面与版本提交视为后续节点已完成。真实文件上传服务本次沿用现有项目资产接口，浏览器文件流程使用隔离响应验证，数据库验证不写对象存储。
