# 运营测试登录与部署

系统使用一个由服务端配置的共享运营账号。该账号可访问现有全部项目；目前没有多用户、角色和用户级项目隔离。账号密码仅在登录接口验证，浏览器通过 HttpOnly Cookie 持有 12 小时会话，退出后数据库立即撤销。修改用户名或密码哈希后旧会话失效；数据库、账号配置缺失时不会回退到免登录。

## 配置账号

在项目根目录执行：

```powershell
node apps/api/scripts/configure-login.mjs
```

按提示输入用户名和密码，密码输入隐藏。脚本只更新本机被 Git 忽略的 `.env` 中的 `AUTH_USERNAME` 与 `AUTH_PASSWORD_HASH`，不保存明文密码。部署服务器须配置同样账号，可在服务器运行该脚本，或通过服务器的 Secret 管理设置这两个变量。不要将本机包含供应商密钥的完整 `.env` 提交到 Git 或分享。

## 部署步骤

1. 配置数据库等既有运行参数和上述登录变量。`APP_ENV=production`；`WEB_ORIGIN` 为运营实际访问的完整 Origin（例如 `https://marketing.example.com`，无路径或尾斜线），多个 Origin 使用逗号分隔。不要配置通配符。
2. 推荐同站部署：网站域名下的 `/api` 反向代理到 API，前端 `VITE_API_BASE_URL=/api`；业务素材和下载请求同样需要 Cookie。同站部署可兼容视频、图片等原生资源请求。
3. HTTPS 设置 `AUTH_COOKIE_SECURE=true`。如果仅在临时受控 HTTP 测试环境使用，显式设 `false`；HTTP 下 Secure Cookie 不会被发送。配置变化后重启 API。
4. 默认 `AUTH_TRUST_PROXY_HOPS=0`，忽略客户端伪造的转发头。仅有一层可信反向代理时设 `1`，并禁止公网直接访问 API 端口，代理必须覆盖客户端传入的 `X-Forwarded-For`。否则限流会以代理地址合并计数，或错误信任转发地址。
5. 加载服务器环境变量后执行 `pnpm --filter @ai-marketing/api db:deploy`，应用迁移，再执行 `pnpm build`。迁移新增 `AuthSession` 和 `AuthLoginAttempt`，不修改现有业务表。Prisma CLI 不自动读取根 `.env`；本地 PowerShell 可用下方命令显式加载。
6. 使用部署进程管理器启动 API 与静态前端，按[本地开发指南](local-development.md)检查实际运行版本。验证健康接口、未登录业务接口返回 401、登录与刷新、退出后原 Cookie 不能访问业务接口。

本地显式加载根 `.env` 的迁移命令（在项目根目录运行）：

```powershell
node --env-file=.env apps/api/node_modules/prisma/build/index.js migrate deploy --config apps/api/prisma.config.ts
```

本地更新到登录功能后，也必须先执行上面的迁移命令，再运行 `pnpm dev`；启动开发服务不会自动迁移数据库。缺少登录表时，携带会话的浏览器会显示“暂时无法连接系统”，首次登录也无法完成。可用同样的命令将 `migrate deploy` 改为 `migrate status` 检查是否还有待应用迁移。

`AUTH_PASSWORD_HASH` 在 `.env` 中须用单引号包裹，配置脚本会自动处理；Docker Compose 会展开未加引号值中的 `$`，破坏哈希。引号只用于环境文件，不是哈希本身的一部分。

登录尝试按网络来源进行 PostgreSQL 原子计数，每个 15 分钟窗口最多 10 次，包括成功登录；窗口结束自动恢复。生产部署为同一应用实例/集群提供同一个数据库和同一账号配置，不缓存鉴权结果。清理过期记录在成功登录时最多每小时执行一次。

Worker 接口继续验证各自 Token；供应商输入接口继续验证任务签名，不使用浏览器账号。健康检查公开，不返回业务资料。登录页面不提供注册、密码找回或演示账号入口。

## 验证范围

### 视频系统依赖与只读检查

API在保存视频前通过ffprobe核对实际时长/尺寸；定制类视频Worker用ffmpeg解码封面，镜像同时保留ffprobe。`deploy/Dockerfile.api`及`workers/customized-production/Dockerfile`均安装Debian的ffmpeg包（包含ffprobe），并在构建中执行只读二进制探针。Python/Node依赖安装成功不能代替这些系统工具。

API的node-slim基底若尚无系统CA，先用[Node 22内置可信根证书](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlsrootcertificates)引导缺失/空的CA bundle，再通过HTTPS APT安装ca-certificates与ffmpeg；已有非空bundle不覆盖。这里使用Node自带的PEM根证书，不关闭TLS验证、APT签名检查或允许未认证软件包。

仓库及运行容器使用同一份探针，不访问数据库、队列、媒体或模型，不执行生成；工具缺失或不可运行时返回非0：

```sh
# 检查当前执行环境；这里只检查，不安装、不重启服务
sh deploy/check-production-runtime.sh api
sh deploy/check-production-runtime.sh customized-production

# 标准镜像构建完成后，检查实际已运行容器
docker compose --env-file .env.production -f compose.production.yaml exec -T api /usr/local/bin/check-production-runtime api
docker compose --env-file .env.production -f compose.production.yaml exec -T customized-production-worker /usr/local/bin/check-production-runtime customized-production
```

探针源码位于`workers/shared/customized-production-runtime/scripts/check-production-runtime.sh`；标准镜像内路径为`/usr/local/bin/check-production-runtime`。发布工具若复用旧依赖基底，必须先检查其系统二进制，缺失时重建包含系统包的层，再拷入源码并重新检查；不能只比较Python清单或Node锁文件。切换服务后还须检查实际新容器。不要为探针或升级中断正在执行的任务。

若视频已在供应商生成成功，仅因缺工具而在本地文件处理阶段失败，先修复运行环境；保留原任务output中的providerTaskId和输入快照。现有`POST projects/:projectId/workflows/customized/production/tasks/:id/retry`会校验原来源/草稿后恢复同一任务，Worker在providerTaskId存在时继续查询/下载，不创建新的供应商任务。当前前端未提供通用恢复入口；由有权限的操作者明确发起恢复，不能以“重新生成视频”代替。来源或文件已失效时保留拒绝，不手工清除检查点绕过。

只读失败诊断可在已有DATABASE_URL环境运行，不需要Worker/模型密钥；只允许显式UUID任务，参数化SELECT在只读事务中执行并ROLLBACK，仅输出脱敏白名单结构：

```sh
node apps/api/scripts/inspect-customized-production-failures.mjs --task TASK_UUID --task ANOTHER_TASK_UUID
```

脚本不输出提示词正文、系统指令、签名URL、凭据或未知原始错误文本；引文只输出长度和是否匹配当前正文。来源、草稿版本及其他活动任务的布尔检查仅作恢复前诊断，正式恢复仍以API事务校验为准。

鉴权 HTTP 自动测试使用隔离的内存 Repository，覆盖真实 Nest 路由、全局 Guard、Cookie、校验器和异常封装；不等同于 PostgreSQL 迁移和服务器端到端部署验证。上线前须在目标环境执行迁移及上述登录检查。浏览器视觉和交互证据见 [2026-10-15 登录验证](evidence/browser/2026-10-15-login/README.md)。
