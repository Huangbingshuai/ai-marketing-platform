# 2026-10-08 视频创作简报文档导入验收

按本次用户修订，文档区统一为“视频创作简报”，文本框及两个区域的项目资产选择按钮、查询和绑定逻辑已移除。文档通过本地选择/拖拽导入，图片独立可选。效果类共用上传、阅读器、图片预览、加载、画布及版本编辑组件继续使用。

下载文件为 `视频创作简报模板.md`，一份文档包含制作目标、产品与展示重点、创作与交付要求，涵盖产品介绍、规格、使用方式、展示重点与准确性约束；允许同时上传多个补充文档。不使用“客户”称呼，不要求样片。

新确认至少须有一份真实有效文档；仅有文字、图片或视频不满足条件。API 校验实际资产文件类型、项目/工作流/Run 作用域、版本及草稿 revision。旧文字继续兼容保存，页面只读查看并可下载为文档；已确认旧内容原样保存不发布新分支，真实变化按新的文档规则校验。

## 验证

72 项相关测试通过：

```powershell
pnpm --filter @ai-marketing/contracts build
pnpm --filter @ai-marketing/contracts test src/customized-import.spec.ts
pnpm --filter @ai-marketing/web test src/workflows/customized src/workflows/effect/source-import/effect-import-layout.spec.ts
pnpm --filter @ai-marketing/api test src/platform/workflow/customized-branches.spec.ts src/platform/workflow/customized-draft.spec.ts
pnpm --filter @ai-marketing/web typecheck
pnpm --filter @ai-marketing/api typecheck
pnpm --filter @ai-marketing/web build
pnpm --filter @ai-marketing/api build
git diff --check
```

本次改动文件 ESLint 和 Prettier 通过。Web 构建仍有大打包块提醒，构建成功，未执行全仓库门禁。

正式页面隔离 API 浏览器回归通过 32 项检查，覆盖无文本框/资产选择、多文档同时选择、失败重试、拖拽上传、参考图片用途、文档和图片查看、旧文字保留与下载、文档必需、版本确认、取消编辑、同内容保存、两轮文档变化、父版本隔离和刷新，以及 1920/1440/390 布局。图片阅读器兼容既有缩略图复用 canvas 与普通图片显示。

真实数据库回滚脚本通过 12 项检查：首次与重复提交、禁止直接修改已确认资料、隐藏编辑复用、旧请求拒绝、真实 revision、无变化返回父版本、取消和历史切换。临时数据全部回滚，模型调用和存储写入为 0；没有自动提交 Git。

API 当前开发服务健康接口成功。浏览器文件流程使用隔离响应，不视为真实对象存储上传端到端验证；后续标准化提炼及生成链路仍未接入。

## 截图

- [1920 布局](2026-10-08-creative-brief-empty-1920.png)
- [1440 已导入文档](2026-10-08-creative-brief-files-1440.png)
- [390 已导入文档](2026-10-08-creative-brief-files-390.png)

截图均为隔离测试资料。
