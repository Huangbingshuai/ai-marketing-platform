# 2026-10-08 定制类加载状态对齐

定制类原加载块缺少居中布局，图标及文字显示在左上角。现从效果类抽取 `WorkflowPageLoading`，两个导入页共同使用。只调整加载展示，不修改项目数据、请求或版本提交。

正式页面以隔离 API 延迟响应保持加载状态，比较 1920、1440、390 宽度：两边加载区高度均为 430px，图标 34px、蓝色，标题 18px，图标和文字组在区域内水平、垂直居中，没有横向溢出或重复加载块。定制类首次进入、刷新均显示共用组件，加载完成后正确退出。

执行结果：

- `pnpm --filter @ai-marketing/web test src/workflows/customized src/workflows/effect/source-import/effect-import-layout.spec.ts`：51 项通过。
- `pnpm --filter @ai-marketing/web typecheck`：通过。
- `pnpm --filter @ai-marketing/web build`：通过，仍有已有的大打包块提醒。
- 三个改动文件 ESLint、`git diff --check`：通过。
- 新组件和定制页 Prettier：通过；效果类页面存在原有格式偏差，本次加载块符合格式，未扩大到整页重排。

截图来自隔离测试项目：

- [定制类 1440](2026-10-08-loading-customized-1440.png)
- [效果类 1440](2026-10-08-loading-effect-1440.png)
- [定制类窄屏](2026-10-08-loading-customized-390.png)

此次为加载展示验收，未触发模型任务或真实资料上传。
