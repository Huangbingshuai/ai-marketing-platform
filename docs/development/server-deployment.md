# 火山服务器运营测试部署

当前入口：https://marketing.richbest.cn 。用户名 `chuyu`，密码使用分配的运营账号密码，本文不保存凭据。

## 部署边界

- 目录 `/opt/ai-marketing-platform`，Compose 项目 `richi-marketing`。镜像发布标识由 `RELEASE_TAG` 指定；首次部署为 `20261015-login`，完整更新使用日期与源码提交组成的独立标识，实际版本记录在服务器 `deployment-logs/`。
- HTTPS 入口按域名代理静态 Web 和 `/api`；浏览器 API 请求仅经过一层可信代理。API、数据库、Redis、RabbitMQ 仅在独立容器网络中通信。
- 新建空数据库，不迁移开发机项目和历史任务。供应商配置通过独立、权限为 `0600` 的 `.env.production` 注入。
- 服务器已有其他应用；本项目使用独立端口和数据卷。当前配置面向 4 核 / 16GB 机器的低并发运营测试。
- 已启用 HTTPS、`AUTH_COOKIE_SECURE=true`、`WEB_ORIGIN=https://marketing.richbest.cn`、`SEEDANCE_REFERENCE_PUBLIC_BASE_URL=https://marketing.richbest.cn/api`。`WEB_BIND_ADDRESS=127.0.0.1`，旧的 18080 端口仅供服务器本机健康检查。
- Worker 部署的是仓库已有能力，不表示五条工作流所有节点都已接通。真实功能边界仍以各工作流指南为准。

## 运维命令

在服务器项目目录执行；不要输出环境文件内容或展开完整 Compose 配置。

```sh
cd /opt/ai-marketing-platform
docker compose --env-file .env.production -f compose.production.yaml ps
docker compose --env-file .env.production -f compose.production.yaml config --quiet
curl -fsS http://127.0.0.1:18080/api/health
```

首次发布先安装依赖/构建 Web 和 API 镜像、准备配置，再执行 `./deploy/start-production.sh` 完成迁移与 Web/API 启动。所有 Worker 镜像构建完成后执行 `./deploy/start-workers.sh`。Worker 构建使用所属锁文件；生产镜像也可在同架构机器构建后通过 `docker save` / `docker load` 迁移。文档解析模型挂载至 `richi-marketing_docling-models`，已有完整模型缓存时可迁移缓存，避免重复下载。本次已迁移并校验缓存，初始化使用 `DOCLING_INIT_OFFLINE=1`；新的空模型卷应设为 `0`，允许首次下载。

更新前先确认没有活动任务、执行数据库备份，再构建并按服务更新。数据库迁移在 API 镜像中运行；构建成功不会自动更新运行容器。

```sh
./deploy/backup-production.sh
docker compose --env-file .env.production -f compose.production.yaml build api
./deploy/start-production.sh
```

Worker 代码或配置变化时，在无活动任务时重建相应镜像，再运行 `docker compose --env-file .env.production -f compose.production.yaml up -d --no-build <服务名>`。不要清理其他项目的镜像、数据卷或容器。

## 备份与访问

备份脚本先检查 `pg_dump` 成功，再压缩并校验，文件保存在权限为 `0700` 的 `backups/`。服务器已配置 `/etc/cron.d/richi-marketing-backup`，每天服务器本地时间 03:30 生成数据库备份。备份位于同一台服务器；需要异地灾备时应另行配置受控备份存储。

容器设置 `unless-stopped` 自动恢复策略和日志轮转。Nginx 关闭访问 URL 日志，避免临时供应商签名进入访问记录。域名入口使用既有 80、443 网关；旧测试端口 18080 现已绑定回环地址，公网不再开放该入口。

## 2026-10-15 已执行验证

- 外网页面与 `/api/health` 返回 200；桌面和 390px 窄屏登录表单无横向溢出。
- 真实 PostgreSQL 会话：正确账号登录、HttpOnly Cookie、刷新会话、退出后旧 Cookie 被撤销。
- 匿名项目/文件访问返回 401；恶意 Origin 写请求返回 403。
- 临时项目创建、TOS 图片上传与原字节读取、项目异步删除完成；测试项目已清理。
- Worker 内部接口：缺少 Token 返回 401，正确 Token 通过鉴权后对不存在的 Run 返回 404。
- 数据库迁移 50 项完成，首份备份生成并压缩校验通过。
- 模型缓存离线初始化成功；效果类、定制类提炼镜像分别在禁止联网、1 核 / 2GB 限额的独立容器中解析一页 PDF，文本断言均通过。

上述验证不调用 Ark、Seedance、TTS、音乐生成；付费生成链路未在本次部署验收中运行。部署完成时 8 个 Worker 均运行、8 个业务队列各有 1 个消费者且消息数为 0；所有应用容器异常重启数为 0，未发生 OOM。模型初始化容器按设计退出，退出码为 0。Docker 与定时备份服务均设置开机启动。清理本次上传的临时镜像/模型安装包后，服务器仍保留约 22GB 磁盘空间。

浏览器证据见 [部署验收截图](evidence/browser/2026-10-15-deployment/README.md)。

## 火山方舟 API Key 白名单

服务器和真实 Worker 的公网出网地址均为 `101.96.224.33`，API Key 白名单应包含该地址（网段格式为 `101.96.224.33/32`）。2026-10-15 首次检查官方 `/ping` 返回 401 和来源 IP 限制；域名接入验收时再次检查已返回 200，来源 IP 限制已解除。本次只验证连通性，没有调用付费模型生成。

官方入口：[API Key 管理](https://console.volcengine.com/ark/apiKey)；规则说明：[管理 API Key](https://docs.volcengine.com/docs/ark/manage-api-keys?lang=zh)。

## HTTPS 与共享入口

- 域名 `marketing.richbest.cn` 已解析至本机。证书由 Let’s Encrypt 签发，初次有效期至 2027-01-13；证书密钥仅保存在服务器 `/etc/letsencrypt`。
- HTTP 自动 308 跳转 HTTPS。配置在 `deploy/domain/marketing-http.conf` 与 `marketing-https.conf`，已分别持久引用到当前 HTTP / HTTPS 共享网关的 Compose。HTTPS 网关接入 `richi-marketing_default` 网络，动态解析本项目容器，避免本项目停机影响其他站点启动。
- 认证、清理与证书热加载 Hook 位于 `deploy/domain/`；`/etc/cron.d/richi-marketing-certificate` 每天 02:45 仅检查并续期本域名证书。现有其他域名证书配置保持原样。
- 共享网关的当前 Compose 文件及 HTTPS 切换前环境配置均备份到权限为 0700 的 `deployment-logs/domain-backups/`，其中环境备份文件为 0600，不得输出或分享。
- 其他应用更换 release/Compose 文件时，须保留营销站点的挂载/配置引用和 HTTPS 网关的外部网络引用；`persist-gateway-configs.py` 记录本次服务器的实际文件位置，不作为跨服务器通用安装器。

域名验收已通过：可信证书链、HTTP 跳转、Secure/HttpOnly Cookie、真实项目读写与 TOS 上传读取、匿名拦截、Origin 拦截、退出撤销、390px 窄屏、八个队列消费者。既有 lens/drama 首页与 api.richbest.cn 健康接口切换前后均返回 200。Certbot 自动续期演练退出码为 0，认证/清理 Hook 通过；证书热加载 Hook 单独执行通过。共享网关配置安装脚本重复运行保持幂等。

截图见 [HTTPS 登录页](evidence/browser/2026-10-15-domain/README.md)。

## 后续真实付费联调

2026-10-16 又完成独立「紫苏梅子酱」项目：30 条 10 秒 Prompt 与 Mini/480P 素材、33 个 24 秒工程全部智能包装并导出，交付清单 revision 1，首次输出独立分支已发布。修复单条包装的旧整模板唯一索引冲突及媒体流二次响应异常，源码与服务器同步，相关 API 303 项通过；原广式腊肠 39 个文件/资产 ID 未变。各节点耗时、恢复费用范围及画面质量限制见 [紫苏梅子酱付费联调记录](../workflows/effect/evidence/browser/2026-10-16-部署紫苏梅子酱/验收结果.md)。

用户随后授权使用「广式腊肠」素材包完成效果类真实付费链路。30 条 Prompt、30 个 Seedance 2.0 Mini 素材以及已包装的 34 条成片已实际导出，重新填充/包装的分支与原分支编辑状态已检查；连续两轮 Prompt 编辑/新增已合并并实际贯通渲染、混剪/自动包装和成片输出局部更新；当前 31 个素材、39 条完整包装成片全部导出，8 个替换、5 个新增、26 个原文件保留，交付原位 revision 2。发现的问题均在本地实现后同步服务器。耗时、失败恢复、媒体抽查限制及本地/服务器同步修复见 [广式腊肠付费联调记录](../workflows/effect/evidence/browser/2026-10-15-部署广式腊肠/验收结果.md)。上述初始部署验收仍只代表当时的只读/免费验证，不能与本次付费任务混算。

## 2026-10-16 代码发布记录

- 播放器与最终导出的画幅适配统一使用 2.5% 对称比例容差；九种菜单画幅和三种自定义比例均纳入回归。浏览器测试另覆盖设备像素取整，避免不同窗口尺寸下出现 1px 黑边；非等比手动缩放仍按工程设置生效。完整范围和证据见[全画幅播放器贴合回归](../workflows/effect/evidence/browser/2026-10-16-全画幅播放器贴合/README.md)。
- 服务器验证包含 12 种比例、3 种来源尺寸、3 种窗口宽度和 DPR 1 / 1.25，共 216 组原生浏览器视频边缘检查。另用实际「广式腊肠」项目确认发布脚本加载及播放；该回归未写入项目数据、未调用生成模型，也未重做导出。
- 服务器更新顺序：先确认所有异步任务均无 QUEUED / RUNNING 状态、Outbox 已发布且各队列无待消费消息；生成 PostgreSQL 备份；拉取指定提交并校验 Compose；构建 API、Web 与有代码变化的 Worker；先执行迁移，再更新 API / Web，最后只重建并更新代码有变化的 Worker。启动 Worker 会消费真实队列，未确认队列空闲前不得重启。
- 上述代码修复此前已单独同步到服务器前端与对应 Worker。2026-10-16 完整代码发布运行提交 `984f84be9ec26a621d08f6c9c7efc481c1e20f57`，发布标识 `20261016-984f84be`；51 项迁移完成，API 健康，8 个 Worker 正常，数据身份指纹未变化。首次尝试因控制器运行时注入问题触发健康检查超时并自动回滚，修复后重新发布成功。完整记录见[系统全量发布记录](evidence/2026-10-16-系统全量发布.md)。部署后始终记录实际提交、健康接口、容器状态和迁移结果；不得把构建成功当作运行服务已经更新。
- 本次全量代码归档的范围、验证结果与已知检查限制见[系统全量发布记录](evidence/2026-10-16-系统全量发布.md)。
