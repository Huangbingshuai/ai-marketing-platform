# apps/api/src/platform/workflow

工作流公共调度、状态和待入库产物管理目录，不承载具体工作流的业务规则。

## 当前节点激活

前端进入用户可见业务节点时调用：

```text
POST /projects/:projectId/workflow-runs/:workflowRunId/nodes/:nodeId/activate
```

该接口只按 `projectId + workflowRunId` 更新 `WorkflowRun.currentNodeId` 和 `lastActiveAt`。它不会创建空节点草稿、修改 `WorkflowNodeState.savedAt` 或增加 revision，也不会提交 `WorkingArtifact`。

节点表单或编辑状态仍通过 `PUT .../state` 保存；节点达到各自提交边界后，才由领域服务提交最新工作副本。项目概览读取激活节点显示“编辑中”，即使该节点尚无可保存的表单内容。
