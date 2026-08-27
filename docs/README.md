# 项目文档导航

`docs/` 按业务边界组织，不再把所有方案堆在根目录。新增文档必须先确定归属，再放入对应目录。

## 目录

```text
docs/
├─ architecture/                 # 整体架构、仓库边界和跨模块设计
├─ development/                  # 本地运行、Agent 指南和通用开发规范
├─ project-assets/               # 项目、草稿、工作副本、Revision 与资产体系
│  ├─ plans/                     # 项目与资产改造计划
│  └─ reports/                   # 迁移、回填和审计报告
└─ workflows/
   ├─ effect/                    # 效果类六节点工作流
   │  ├─ plans/                  # 节点实施方案
   │  ├─ guides/                 # 通俗说明和操作说明
   │  ├─ deployment/             # 该工作流专属部署方案
   │  └─ evidence/               # 浏览器与验收证据
   ├─ customized/                # 定制类七节点工作流
   └─ fission/
      ├─ clone/                  # 爆款复刻
      ├─ avatar/                 # 数字人口播
      └─ local-replace/          # 局部元素替换
```

## 入口

- [系统架构](architecture/system-architecture.md)
- [目录结构与前后端边界](architecture/repository-boundaries.md)
- [本地开发与运行](development/local-development.md)
- [项目、草稿、工作副本与资产](project-assets/README.md)
- [工作流文档](workflows/README.md)

## 新文档放置规则

- 系统级架构：`architecture/`
- 项目、资产、工作副本与 Revision：`project-assets/`
- 某条工作流业务说明：`workflows/<workflow>/`
- 实施计划：所属业务目录下的 `plans/`
- 浏览器截图和验收证据：所属工作流的 `evidence/`
- 通用开发工具与操作：`development/`
- `docs/` 根目录只保留本导航，不新增零散计划。
