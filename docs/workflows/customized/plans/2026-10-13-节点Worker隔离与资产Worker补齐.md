# 定制类节点 Worker 隔离

## 事实与目标

信息提炼、脚本创作已有独立 Worker。资产整理 ASSETS 与视频制作 SHOTS/PROMPT 当前同由 customized-production-worker 领取，缺少独立资产 Worker。按用户要求拆为 customized-assets-worker 与 customized-production-worker，各有入口、包、锁文件、容器、队列和 Token。资料导入不建 Worker；素材交付尚无真实异步实现，后续接通时独立部署，不启动空消费者。

## 数据与边界

资产准备读取已确认脚本及简报准确 revision，输出 customized-asset-catalog / customized-object，生成只写草稿，人工保存确认。视频制作读取脚本与确认资产，输出 video-plan / shot / shot-prompt，维持现有提交规则。拆分只改任务路由、消费者部署与权限，不改任务表、快照、检查点、来源或业务 revision，不接图片与视频渲染，不付费测试。

## 实施

1. 将共用制作执行、结构校验和请求能力移至 shared/customized-production-runtime；原脚本包保留兼容导出用于历史工具，不跨 Worker 导入内部模块。
2. 独立资产/视频入口锁定允许的 operation；API Token 和领取/心跳/检查点/成功失败回调均校验所属节点。ASSETS 路由 customized.assets.requested，SHOTS/PROMPT 保留 customized.production.requested；消息仍只含标识。
3. 重试、过期恢复及既有 Outbox upsert 均按 operation 路由。对旧队列中的资产消息提供幂等重路由，不丢失排队任务，不执行模型。
4. 新增轻量资产和视频 Worker 构建，保留相同模型配置、超时、并发与有限重试，不装 Docling/Torch。验证无活动任务后更新 API 及受影响容器，不重启其他 Worker。

## 验收

受控测试覆盖队列/Token/operation 隔离、旧消息重路由、租约和旧回调拒绝、原检查点恢复及 Schema 一致性；运行 Python pytest/mypy、API 单元/数据库隔离测试、typecheck/build、Compose config 与 diff check。实际启动两个服务，确认各队列消费者及日志，不用容器运行状态代替业务端到端验证。不提交 Git。
