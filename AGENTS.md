# AGENTS.md

## 1. 项目定位

本项目是公司内部使用的AI营销视频素材生产系统。

系统包含三大业务模块：

1. 效果类工作流
2. 定制类工作流
3. 裂变类工作流
   - 爆款视频复刻
   - 数字人口播
   - 局部元素替换

当前开发优先级是：

1. 公共项目与任务底座
2. 效果类黄金链路
3. 定制类工作流
4. 裂变类工作流

没有明确要求时，不要提前开发后续模块。

## 2. 当前技术栈

- 前端：Vue 3 + TypeScript + Vite
- 后端：NestJS + TypeScript
- 数据库：PostgreSQL
- ORM：Prisma
- 包管理：pnpm
- 异步任务：RabbitMQ
- 缓存与任务进度：Redis
- 对象存储：TOS
- 视频生成：Seedance
- 视频处理：Python + FFmpeg

不要在没有说明原因的情况下替换现有技术栈。

增加新的生产依赖前，先说明：

- 为什么需要
- 解决什么问题
- 是否已有依赖可以完成
- 对构建和维护的影响

## 3. 目录边界

前端和后端必须分别维护，禁止跨应用直接引用源码：

- `apps/web`：Vue 前端应用，只负责页面、交互状态和调用 HTTP API
- `apps/api`：NestJS 后端应用，只负责业务规则、数据访问和任务调度

前端公共平台能力放在：

- `apps/web/src/platform/project`：项目上下文与项目切换
- `apps/web/src/platform/asset`：资产选择与资产管理界面
- `apps/web/src/platform/file`：上传与文件预览
- `apps/web/src/platform/job`：任务状态与进度展示

后端公共平台能力放在：

- `apps/api/src/platform/project`：项目管理
- `apps/api/src/platform/asset`：资产管理
- `apps/api/src/platform/file`：文件管理
- `apps/api/src/platform/workflow`：工作流公共调度
- `apps/api/src/platform/job`：异步任务

三大业务工作流分别放在前后端自己的 `workflows` 目录：

- `apps/web/src/workflows/*`：工作流前端页面、组件、Store 与 API 客户端
- `apps/api/src/workflows/*`：工作流后端模块、领域服务与数据访问

工作流固定划分为：

- `effect`
- `customized`
- `fission/clone`
- `fission/avatar`
- `fission/local-replace`
- `fission/shared` 仅允许裂变类三个子工作流内部复用

共享类型放在：

- `packages/contracts`

共享前端组件放在：

- `packages/ui`

工作流只能调用公共平台能力，不能把业务逻辑写进公共平台目录。

效果类、定制类和裂变类之间禁止直接引用内部实现。

确实需要共享的代码，应提取到：

- `packages/contracts`：前后端共享的数据契约
- `packages/ui`：前端共享的无业务 UI 组件
- 对应应用的 `platform`：应用内部公共能力
- 对应应用的 `workflows/fission/shared`：裂变类内部公共能力

前端不得导入 `apps/api`，后端不得导入 `apps/web`。前后端只能通过 HTTP API 和 `packages/contracts` 中的数据契约协作。

## 4. 核心业务规则

所有业务数据必须包含 `projectId`。

任何查询都必须按当前项目隔离，禁止项目之间串数据。

工作流生成结果首先是待入库产物，不得自动成为正式项目资产。

用户点击“保存到项目资产库”后，才能创建正式资产。

同一个工作流产物重复入库时，应创建新版本，不创建重复资产。

跨项目复用采用复制快照：

- 目标项目创建新的资产ID
- 保留来源项目ID
- 保留来源资产ID
- 保留来源版本
- 修改目标资产不能影响源资产

系统公共资产必须先导入当前项目，工作流才能使用。

## 5. Seedance调用规则

前端禁止直接调用Seedance。

正确调用链路：

1. 前端请求NestJS API
2. API创建异步任务
3. Worker调用Seedance
4. Worker轮询任务状态
5. Worker保存生成结果
6. API向前端返回任务进度和结果

Seedance密钥只能存在于后端环境变量。

禁止把API Key写入：

- 前端代码
- Git仓库
- 测试文件
- Mock数据
- 日志输出

Seedance接口暂时不可用时，保留相同接口结构并使用后端Mock实现。

## 6. 前端开发规则

正式页面禁止继续使用组件内写死的业务数据。

即使暂时使用Mock数据，也必须通过API或Mock Service返回。

页面状态至少区分：

- 初始状态
- 加载状态
- 成功状态
- 空状态
- 失败状态

不要修改任务范围之外的UI。

复用原型时，原型只作为布局和业务流程参考，不直接复制整份HTML到正式项目。

公共组件放入 `packages/ui`；仅单个工作流使用的组件保留在对应工作流目录。

## 7. 后端开发规则

Controller只处理：

- 请求参数
- 权限与项目上下文
- 调用Service
- 返回结果

业务规则放在Service或Domain层。

数据库访问通过Repository或Prisma Service完成。

禁止在Controller中直接编写复杂数据库查询和工作流逻辑。

异步视频任务不得阻塞HTTP请求。

所有创建、查询、修改和删除操作必须校验 `projectId`。

## 8. 类型与接口规则

前后端共用的数据类型放在：

`packages/contracts`

开发前后端并行功能前，先定义并提交接口契约。

禁止前端和后端分别维护两套含义相同但字段不同的类型。

API响应采用统一结构：

```ts
type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
  requestId?: string;
};
```

## 9. 原型参考规则

正式功能开发可以参考 `references/prototypes/` 中冻结的业务交互原型，但原型仅用于理解：

- 业务流程和步骤顺序
- 页面信息结构和业务字段
- 布局、配色和交互反馈
- Mock 场景、状态和异常文案

禁止直接复制原型中的整份 HTML、内联 CSS、全局脚本或组件内 Mock 实现。所有正式功能必须使用当前 Vue、NestJS、Prisma 和共享契约重新实现。

每个开发任务必须明确说明：

- 参考哪个原型文件
- 只参考原型中的哪个业务模块或页面区域
- 本任务允许实现的功能范围
- 明确不在本任务中实现的相邻模块

不得只写“参考原型实现”。如果任务没有给出具体参考区域，应先检查原型并把范围收敛到当前功能，禁止顺带迁移整套页面。

当原型、任务说明和本文件存在冲突时，优先级为：

1. 用户当前任务要求
2. `AGENTS.md` 中的工程与业务规则
3. 冻结原型中的交互和视觉表现

复用原型时应保持用户已经确认的页面结构、字段和视觉语言；如需偏离，必须先说明原因。原型中的网络调用、数据存储方式和技术实现不具有约束力。
