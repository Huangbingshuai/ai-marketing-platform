# 信息提炼与片段渲染下一步导航修复

2026-10-16，环境 https://marketing.richbest.cn，项目「广式腊肠」，当前 Run `2d7d795c-d194-4911-bd46-d625c608ad73`。

修复前在浏览器实际复现两个底部按钮均 disabled。信息提炼返回 COMPLETED、工作副本 revision 1、commitStatus DRAFT_CHANGED；片段渲染返回 COMPLETED、31 个素材、工作副本 revision 2、stale=false、commitStatus DRAFT_CHANGED。顶部流程图能够正常导航，底部却要求所有提炼结果或当前渲染结果必须 COMMITTED，造成不一致。此修复不改写这些业务状态或强制确认草稿。

底部下一步改为普通导航，与顶部沿用同一 selectWorkflowStep、草稿 flush 和节点 activate 机制。信息提炼只在保存版本/编辑切换请求中短暂禁用；片段渲染只在显式操作/编辑切换请求中短暂禁用。导航不代替保存、校验或生成，未确认来源仍由既有 API 拒绝执行生成。

本地及服务器已同步两个 Vue 页面与提炼 README；生产入口升级至 `index-DRAe4cpm.js`。仅原子替换 Web 静态入口、保留旧静态资源，没有重启 API/Worker或创建付费任务。部署时 index.html 临时权限为 0600 导致首页短暂 403，已立即纠正为 0644，首页、脚本及 API 恢复 200；服务器与本地两页面 SHA-256 完全一致。

验证：新增真实 Footer 模板/事件回归修复前 3 通过、9 失败，修复后 12/12 通过，覆盖未生成、草稿变化、待更新、后台任务、已确认以及保存期间禁用。提炼/渲染相关前端共 237 项通过；`pnpm --filter @ai-marketing/web build` 含 vue-tsc 和 Vite 构建通过；新增测试 ESLint 与 `git diff --check` 通过。

线上已实际点击「下一步：素材 Prompt」到达 Prompt 页面，点击「下一步：模板混剪」到达模板配置页面。导航网络写入仅有既有节点 activate，没有生成请求。两页在 1920/1440/390px 下按钮均可用；刷新后重新打开对应节点，再次点击仍能到达 Prompt 或模板配置页面。全部导航请求记录中生成请求为 0。

截图：[提炼修复前](extraction-before.png)、[提炼修复后](extraction-after.png)、[渲染修复前](render-before.png)、[渲染修复后](render-after.png)、[提炼按钮](extraction-footer-enabled.png)、[渲染按钮](render-footer-enabled.png)。
