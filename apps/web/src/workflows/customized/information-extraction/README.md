# 定制类信息提炼前端

正式定制类页面的第二节点使用 `CustomizedInfoExtractionNodePage.vue`。画布、版本树和节点导航仍由既有定制导入页面统一管理，提炼页不创建另一套项目或 Run 状态。

页面包括项目与用途、品牌与产品信息、目标受众、创意与风格、视频规格。复用 `WorkflowInformationCard`、`WorkflowInformationField`（同时用于效果类提炼）、编辑动作、加载、进度、底部导航、资料行和图片预览。来源内容通过父页面的共用资料阅读器查看，固定引用版本不改写。

`customized-extraction-view.ts` 仅是受控 UI 展示模型，不是 API DTO。模型通过 props 输入、事件输出，不在页面中自动提交、存储结果或推进 revision。专用后端未接入时 `available` 默认 false，字段只读、生成和版本操作禁用；生产页面没有 Mock 回退。未来接通必须先定义共用契约和标准化 Brief 提交边界，不能把草稿或前端事件当作确认产物。

隔离浏览器验收用例可通过显式 fixture 展示状态与操作，不代表真实模型、版本发布和数据库持久化已经完成。详见[前端验收](../../../../../../docs/workflows/customized/evidence/browser/2026-10-09-information-extraction-frontend.md)。
