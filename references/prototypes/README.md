# 历史交互原型

本目录保存正式工程开发前完成的 HTML 交互原型。

这些文件仅用于参考：

- 页面布局
- 业务流程
- 交互行为
- Mock 业务数据
- 系统视觉风格

## 原型列表

### `integrated/system-integrated-demo.html`

三大业务模块整合版，用于参考系统导航、项目入口、资产入口和整体视觉。

### `effect/effect-workflow.html`

效果类完整业务流程原型。

### `effect/effect-mix-workbench.html`

效果类模板混剪、成片工程和时间轴精修原型。

### `customized/customized-workflow.html`

定制类完整业务流程原型。

### `fission/fission-workflows.html`

裂变类原型，包含：

- 爆款视频复刻
- 数字人口播
- 局部元素替换

## 使用规则

- 原型不是正式生产代码。
- 正式工程禁止通过 iframe 直接加载这些原型作为业务页面。
- 正式页面应使用 Vue 组件重新实现。
- 原型中的 Mock 数据不能直接作为正式数据库结构。
- 业务细节以独立工作流原型为主要参考。
- 系统导航和整体视觉以整合版为辅助参考。
- 正式开发开始后，本目录原型原则上冻结；需求变化应更新产品文档和正式代码，而不是继续维护两套实现。

## 来源

原型快照复制自 `ai_maketing_asset_system` 项目的当前开发版本。

复制日期：2026-08-20。
