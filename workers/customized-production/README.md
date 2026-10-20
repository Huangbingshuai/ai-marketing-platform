# 定制类视频制作 Worker

本服务处理视频制作节点的 `SHOTS`（分镜及对象绑定）、`PROMPT`（逐镜提示词）和 `RENDER`（逐镜视频渲染），不执行资产准备的 `ASSETS` / `IMAGE` 任务。

RENDER 复用效果类的 Seedance 传输适配，执行渲染依据、准备参考图、生成视频、视频文件校验、原位保存视频。API 冻结已确认分镜、提示词、模型配置及正文实际 `@` 引用的图片版本，不传递全部候选素材。创建后持久化供应商任务身份，重领继续查询或下载；创建结果未知时停止重复提交，限流时有界重试。MP4 与 JPG 封面经 API 校验时长、尺寸和文件完整性后，自动提交 `customized-clip-video:<clipId>`，不新增分支；失败保留旧视频。

API 复用效果类 `SEEDANCE_MODEL_2_5 / SEEDANCE_MODEL_2_0 / SEEDANCE_MODEL_2_0_MINI / SEEDANCE_MODEL_2_0_FAST` 配置并冻结模型。Worker 使用 `SEEDANCE_BASE_URL / SEEDANCE_API_KEY`，未单独提供时使用 Ark 配置。`CUSTOMIZED_VIDEO_RENDER_TIMEOUT_SECONDS` 默认900秒，`SEEDANCE_POLL_INTERVAL_SECONDS` 默认8秒。Compose 并发为1，生产内存预算1536MB。镜像安装 FFmpeg 解码封面，API 环境须提供 ffprobe；不安装 Docling、Torch 或浏览器。不静默替换模型或裁剪时长。见[渲染计划](../../docs/workflows/customized/plans/2026-10-19-逐镜视频渲染接通.md)。

新PROMPT任务冻结`promptWorkflowVersion=3`，执行本镜创作依据、画面与素材安排、视频提示词创作、独立审校、定向修订与复核、原位保存提示词。正常两次主要模型调用，确定性的呈现安排不额外调用模型；仅实质ERROR进入一次修订与复核。V3专属审校只审当前提示词，非INPUT问题必须给出真实正文引文；API/Worker机械核对引文来源，避免将上游描述当作新稿错误。保留本镜完整事实、原句、素材及实际时间窗，不重复传递无关全片和两份简报。V2及无标记历史任务保留原Schema。可读`@素材全名`、连续画面时间窗和原稿声音/文字分别校验；实际引用可为候选子集，`assetIds`与正文一致。成功自动原位提交`customized-clip-prompt:<clipId>`，不创建分支。Web末节点已改为直接编辑和自动保存，相关边界见[后续计划](../../docs/workflows/customized/plans/2026-10-19-视频制作直接编辑与素材引用交互.md)及[初始计划](../../docs/workflows/customized/plans/2026-10-19-逐镜提示词工作流与右侧查看入口.md)。

| 配置                   | 值                                                       |
| ---------------------- | -------------------------------------------------------- |
| Python 入口            | `python -m customized_production.main`                   |
| Compose 服务 / profile | `customized-production-worker` / `customized-production` |
| 队列                   | `customized.production.requested`                        |
| 内部 API               | `/internal/workers/customized-production/tasks/:id`      |
| 独立凭据               | `CUSTOMIZED_PRODUCTION_WORKER_TOKEN`                     |

新建分镜任务由服务端冻结 `shotWorkflowVersion=2` 与 `2026-10-19-capacity-clips.7`。消费已确认脚本、简报及资产目录，正文建立不可变字符索引。导演规划核对完整内容容量，再生成完整分镜；脚本时长是参考，不把篇章估时当作硬上限。视频制作不增加时长设置入口。一条视频任务对应一份完整分镜，新结果必须一个clip对应一个shot，不生成独立子镜头，必要画面变化在同一份visual中表达。生成、修订及API完成均验证一一对应。Prompt只处理当前完整分镜及实际绑定对象，跨任务声音只分配本段原句。旧策略任务及历史多镜头文件保留兼容；前端只读合并，实际编辑时准确平移声音时间点。见[一一对应计划](../../docs/workflows/customized/plans/2026-10-19-视频任务与分镜一一对应.md)。

六个执行阶段为创作依据、导演规划与容量核对、分场创作与绑定、对照原文独立审校、问题修订与独立复核、保存待确认分镜。普通单批为3次模型调用，B个创作批次为B+2次；确有ERROR时最多增加一次局部修订和一次独立复核。结构修订可以拆并镜头、片段和合理调整参考模式时长，保留原稿、正常范围与真实变化。检查点在采用前持久化；恢复只复用同任务、同输入的有效候选，不重买已完成阶段。V1历史任务保持原策略，不跨版本解释旧结果。

首审与局部复核共用问题身份；级别改变必须留下原级别、新级别、具体依据和首审纠正/新增证据记录。复核只重新检查实际变化及相邻衔接，未改范围的建议原样保留；有真实新错误仍阻止采用。纯时长和声音落点使用小补丁，确需拆并才返回结构替换。七维独立首审、原句/事件覆盖和完整结构校验保留。代码将声音/画面文字的原文区间和镜头内时间确定性展开为片段内时间窗，审校直接看实际原句与分配秒数，不能以全片或片段总时长代替口播实际容量；不使用统一字数公式硬拒绝。产品未知结构、端口顺序与充电状态不能由镜头创作补造。新候选片段的起止摘要直接投影首末镜头，局部修订只对问题范围同步，避免重复摘要矛盾触发无必要的整段返修。

分镜成功先写编辑草稿，末节点页面观察到完整成功并加载真实结果后，通过现有校验和确认API自动保存分镜及目录；关闭页面期间形成的恢复草稿在下一次真实修改或生成前确认，不因普通读取提交。逐镜Prompt完成且服务端核对通过后自动提交。失败候选可只读核对，通过来源及机械校验才能明确转入人工草稿，失败状态不伪装为AI通过。资产准备由 [独立资产 Worker](../customized-assets/README.md) 负责。

`CUSTOMIZED_PRODUCTION_CONCURRENCY` 默认 2，`CUSTOMIZED_PRODUCTION_TIMEOUT_SECONDS` 默认 300，`CUSTOMIZED_PRODUCTION_MAX_ATTEMPTS` 默认 2；模型配置冻结在任务中。Ark、RabbitMQ 和内部 API 配置由环境注入，不在日志输出正文或密钥。运行依赖[共享底座](../shared/customized-production-runtime/README.md)，视频渲染额外安装 FFmpeg。

`CUSTOMIZED_PRODUCTION_TASK_CONCURRENCY` 默认 4，范围 1–4，控制独立消息并行数；与上述文本模型调用并发分开。不同片段的 Prompt 和 Render 可以重叠执行，同片段及整份分镜任务由 API 在项目事务锁内互斥。每个消息独立持有租约、供应商身份和确认/重排状态，单项失败不取消其他片段。资产 Worker 仍逐个消费消息。

```powershell
docker compose --profile customized-production build customized-production-worker
docker compose --profile customized-production up -d --no-deps customized-production-worker
docker compose --profile customized-production ps customized-production-worker
uv run --project workers/customized-production --frozen pytest workers/customized-production/tests
uv run --project workers/customized-production --frozen mypy workers/customized-production/src workers/shared/customized-production-runtime/src
```

API 必须已加载相同凭据；在无活动任务时更新服务。旧 `customized_storyboard.production_main` 仅保留兼容入口，并限制为视频制作角色，不再处理资产任务。旧队列资产消息只转交 API Outbox，不在本服务调用模型。重复终态消息只确认领取状态，不重新生成。

容量、片段及结构修订设计见[实施计划](../../docs/workflows/customized/plans/2026-10-19-分镜容量与片段分层及结构修订重构.md)。

本次隔离验收见[记录](../../docs/workflows/customized/evidence/2026-10-13-资产Worker隔离验收.md)。
