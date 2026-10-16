# 定制类分镜创作 Worker

独立 Python 消费者，消费 API 冻结的已确认信息卡。通过受保护内部 API 保存检查点、发布脚本，永不直连数据库。新批次固定一份；历史 1–5 份批次仍按原快照恢复，失败恢复不覆盖已发布结果。

`.10` 在原同一次创作审校中先读取全文机制诊断，再给三项质量结论：AI判断讲解是否主导对白、结尾是否为脱离前文的情绪补丁，代码只将相应枚举投影为已有FAIL，不按关键词/字数做语义判断，也不允许总体好评冲掉结构缺陷。引用真实正文铺垫与收束，公开输出仍为原审校DTO和共享详情；自然温暖、荒诞幻想与开放结尾不自动拒绝。正常五次主要调用与中等推理/并发2不变，旧`.9`按原Schema恢复。见[机制审校计划](../../docs/workflows/customized/plans/2026-10-16-短剧审校主线与结尾机制.md)与[付费记录](../../docs/workflows/customized/evidence/2026-10-16-短剧机制审校付费复测.md)。

`.11` 根据`.10`真实漏判，将“观看体验”置于机制诊断之前，区分可展开的人物/信息/喜剧/情绪主线与只讲通使用流程的剧情外壳；AI判后者时投影既有剧情FAIL，总体好评不能冲掉。供应商引用编号限定为实际正文枚举，减少拼接编号导致的纠错；不按关键词拒稿，不限制幻想/自然温暖，不增调用或提高并发。具体结果沿用本轮机制审校计划和证据。

## 正式剧本格式（2026-10-13）

代码中剧情短片新任务冻结 `2026-10-16-drama.11`，用户不选二级类型。系统组合对话、反转、悬念、情绪等手法开发三个短故事，再独立择优形成一份完整稿；历史任务仍开发 `min(7, N+2)` 个候选。选中原案确定性投影，不在选择阶段重写人物选择与伏笔。候选开发和选择分别持久化，弱案仅允许一次整组替代；恢复不重置预算。正文消费原案及必须兑现内容，创作审校只读实际正文；事实侧独立核查完整资料。正常单份五次主要调用、需修订增加三次；短候选开发使用冻结Pro低推理，其余Pro中等推理、模型并发2。原租约、自动发布、一次定向修订/双路复核与公共面板保持复用。旧剧情策略按原版本恢复。参见[本轮计划](../../docs/workflows/customized/plans/2026-10-16-单条剧情自由创作与质量复测.md)；先前`.5`实测见[历史验收](../../docs/workflows/customized/evidence/2026-10-16-剧情短片质量校准进展.md)。

`.4` 起使用完整独立策略，开发读取同路线历史概要避重；先选适合参考规模的人物事件，返修只处理命中单元。`.5` 开发输入聚焦产品介绍、卖点、受众、项目意图与品牌约束，保留原事实ID；择优、正文和事实审校仍读取完整简报。API 只提供本项目已确认同类型脚本，包含旧来源头，作为 AI 软避重；不靠关键词判断创意。普通措辞偏好不阻断，未修好 ERROR 不发布。旧 `.1/.2/.3/.4` 不变。容器已更新并完成充电器真实浏览器任务，具体耗时及审校分歧见验收记录。

`.6` 使用更短的完整创作策略，开发读取完整简报，自由探索剧情看点与产品宣传关联；不要求所有故事温情和解，不把产品不可替代或促成关系转折当硬条件。允许明确的幻想/拟人表达，真实事实仍由独立检查核对。容量检查考虑自然剪辑及动作对白并行，明显不足仍拒绝；专用局部编辑指令要求修改实际冗余内容并诚实估时。返修/事实复核保留全部问题，省去重复好评与长总结；其他线路和旧策略的输入/指令保持原样。

`.7` 先在既有viewingPromise中写一个完整短剧点子，再展开结构化计划；开发输入聚焦产品特点、外观、受众和品牌边界，正文与事实侧保留完整来源。devices表示创作手法。独立选择/创作审校区分真正的短剧看点与被截止期包装的参数流程，不强制固定题材或剧情模板。保留`.6`原始真实结果作对照；调用和返修预算不变。

`.8` 将剧本与分镜计时分开：作者估时保留用于展示，不作为已确定镜头时长参与事实核查，避免几秒分歧触发重复返修；节奏密度只作提醒。明确幻想/夸张及角色误会不自动视为真实功能承诺，不作现实主义审查，真实产品宣传及用户品牌/结构约束仍独立核对。聚焦编辑只传ERROR，保留全部WARNING供查看。AI编排的结构映射确定性为空，不购买额外纠错调用；自定义结构仍严格检查R引用，原始补丁保留用于恢复。
`.9` 在同一候选契约中仅调整新任务的供应商Schema属性顺序，把viewingPromise置于八项plan之前；缩短重复说明，不新增模型调用或提高并发。独立择优/审校以全文主导事件、对白用途与结尾回收判断，不用一句关照替大段参数讲解辩护；允许荒诞幻想，也保留成立的生活化/温暖表达，不按关键词或参数数量作语义拒绝。旧`.8`及此前的指令、Schema顺序和任务恢复保持原样。本轮计划见[想象力与审校优化](../../docs/workflows/customized/plans/2026-10-16-短剧想象力与审校区分度优化.md)，实际结果见[付费复测](../../docs/workflows/customized/evidence/2026-10-16-短剧想象力与审校付费复测.md)。

`scripts/verify_paid_drama_calibration.py` 为单独的真实创作审校校准工具：要求显式设置 `CUSTOMIZED_STORYBOARD_PAID_TEST=1`，提供样稿 JSON、结果文件及准确的 `--version`。样稿数组每项为 `id / model / brief / story / expected`，`expected` 可省略且只用于离线对照，标识和期望不进入模型。成功样稿及原始审校持久化恢复，不重复购买已完成样稿；只允许一次引用/结构纠错，不为改变实质判断重试。它不创建项目脚本、不替代完整任务或浏览器验收；模型使用样稿指定的冻结型号，沿用环境中的方舟配置。

当前新任务使用 `TYPED_CREATION_V1 + VIDEO_SCRIPT_V3`。`routes/` 分别定义带货、到店、品牌、剧情的规划、写作及审校；`typed_creation.py` 复用同一个 Provider、并发限额、API 检查点和任务生命周期。快照/依据准备/路由不调用模型，品牌/剧情先保存候选方向再择优，每份正文完成后并行执行创意和事实审校，通常 N 份需要 2+3N 次主要调用，需修订的方案各增加一次修订和两次独立复核。历史带货及到店保持1+2N，修订各增加两次；当前独立带货策略见下文。格式纠错及请求重试另计。没有新增四套 Worker。

新图：SNAPSHOT → PREPARE → ROUTE → 所选类型_CONCEPT → 类型_STORY → 类型_REVIEW → REPAIR → RECHECK → SAVE。无需修订时后二者明确跳过；资料不足保存具体缺口，停止正文。任务冻结 routeId、graphVersion 和 strategyVersions，不在恢复时换新策略。当前版本 `2026-10-14.7`；2026-10-13 的 `.1/.2/.3/.4/.5/.6/.7/.8/.9/.10/.11` 及 `2026-10-14.1` 仍可按冻结策略恢复。

V3 正文以 `P01｜自然篇章标题` 展开；自定义结构通过 `structureMapping` 引用正文单元与准确引文，不限定标题或篇章数量。`creation` 保存类型、参考时长和结构；时长仅引导规模，独立审校继续检查真实容量。`.3` 起修订返回 `TypedPatch`，只替换明确命中的篇章和必要辅助字段，不重编号或改动未涉及正文；完整复核单独持久化。Schema 位于 `packages/contracts/schemas/customized-typed-script-*.schema.json`，pytest 验证一致性。正文默认整篇生成；供应商明确返回输出超限且有限扩容重试仍失败时，转为自然篇章规划与逐篇生成，每篇持久化，恢复只补未完成部分。不是按180秒机械分片；完整前文、全局规划及事实保留，最终仍统一审校。输出超限恢复已用受控适配器验证，未人为购买超长内容来触发真实超限。

.4 在原独立审校调用中增加三项类型质量判断，每项引用真实正文并说明结论；FAIL 必须进入定向修订，复核仍失败不发布。Worker 与 API 同时校验篇章、准确引文、路线及失败状态一致性。正常稿不增加模型调用，详情使用共享工作流面板展示依据。`.5` 审校移除当前方案的创意计划与自我说明，先引用正文再作质量判断；引文或篇章校验失败时最多纠错一次，不重新购买正文。`.6` 审校使用完整正文的原文片段索引，模型选取 evidenceId，Worker 确定性回填原文；服务端继续验证最终逐字证据，避免模型重新抄写导致的纠错耗时。修订按实际对白与动作估时，不为参考总时长挪用其他正常篇章的秒数。旧策略继续原审校 Schema，不能用新规则阻断历史恢复。

`.7` 独立主编只评实际正文篇章，移除作者辅助概述；模型判断已体现、实质反证、未体现及不足范围，结构性缺陷不能被总体好评覆盖。仍投影为同一三项质量契约与共享详情，不增加正常任务模型调用。剧情侧重行动、潜台词和人物承担选择；品牌侧重实际视觉关系发展，操作目录与参数更新不能替代创意。多产品正反样稿位于 `tests/fixtures/editorial-calibration.json`，期望仅用于离线评估，不送模型；旧稿复评及充电器新稿测试见[去说教与审校校准验收](../../docs/workflows/customized/evidence/2026-10-13-剧情去说教与品牌审校校准验收.md)。

`.8` 将品牌/剧情的创意与事实审校分成独立请求，仍显示在同一审校节点。创意侧只读实际正文、品牌调性及受众，不以规格覆盖率替代创意；事实侧保留全部简报，核查能力、连接、约束与真实容量。任一实质问题均阻断发布。两个子审校各自保存检查点，绑定正文指纹；重试只补缺失侧，复核不能复用旧正文结果。全部模型请求共享并发上限 2。先生成短候选、再择优深化，不增加固定业务节点，不用产品词匹配判断质量。

`.9` 基于付费漏判对照，仅将品牌/剧情候选、择优和创意审校设为 high，正文与事实检查保持 medium。弱候选允许整组淘汰，避免机械挑选；创意审校 Schema 限制 shotIds 为空，本节点引用篇章而非镜头。不会以提高并发或降低质量门槛缩短耗时。

`.10` 将构思恢复 medium，并在择优时直接应用成稿审校门槛、允许推翻整组弱候选；只有创意审校/复核使用 high，事实、正文和修订保持 medium。候选高推理耗时与质量不匹配的试验详见本轮验收。

V2 保持原同名/同数量结构校验及原检查点；SCREENPLAY_V1 和无标记任务继续历史格式与时长规则。品牌图片不进入模型，旧“创作要求”不参与 V3。以下旧场次和分镜说明仅用于历史任务。

历史 `SCREENPLAY_V1` 的 `STORY_ONLY` 任务：正式正文由连续场次组成：场景标题、动作、必要对白；不在脚本创作阶段拆镜。`ScreenplayDraft` 只生成完整 `beats[].content`，代码拼接为唯一 `story.content`，避免重复输出。共享 Schema 位于 `packages/contracts/schemas/customized-screenplay-draft.schema.json`，pytest 核对 Python 一致性。

独立审校检查事实、动作/对白与时长容量、连续性及方案差异；定向修订后再独立复核。正常脚本不增加额外调用，格式问题最多一次修正，检查点恢复不会重新购买已完成正文或修订。旧任务没有格式标记时保留原恢复路径。真实测试须显式授权并单独记录，不使用字数门槛代替内容审查。

## 运行

仓库根目录设置 API / Worker 相同的 `CUSTOMIZED_STORYBOARD_WORKER_TOKEN` 和真实 `ARK_API_KEY`，数据库应用 `20261012090000_customized_storyboard` 与 `20261012140000_storyboard_automatic_recovery` 迁移。然后：

```powershell
docker compose --profile customized-storyboard build customized-storyboard-worker
docker compose --profile customized-storyboard up -d customized-storyboard-worker
docker compose logs --tail 30 customized-storyboard-worker
```

启动消费者可能执行队列中的真实付费任务；不要用生产队列做免费模拟验收。更新容器前核实没有活动任务。镜像只安装 aio-pika、httpx、Pydantic 和共享请求包，不安装 Torch、Docling、浏览器或视频工具。

API 冻结模型名称：创意 / 故事 / 审校默认 `doubao-seed-2-1-pro-260915`，资产定义 / 镜头细化默认 `doubao-seed-2-1-turbo-260628`。事实或故事修订用 Pro，纯结构修订用 Turbo。部署配置为 `CUSTOMIZED_STORYBOARD_CREATIVE_MODEL` / `CUSTOMIZED_STORYBOARD_DETAIL_MODEL`，不修改效果类配置，不静默降级。

| Worker 配置                             | 默认值                            |
| --------------------------------------- | --------------------------------- |
| `INTERNAL_API_BASE_URL`                 | Compose 中跟随 `API_PORT`         |
| `RABBITMQ_URL`                          | Compose 中复用 RabbitMQ           |
| `CUSTOMIZED_STORYBOARD_QUEUE`           | `customized.storyboard.requested` |
| `CUSTOMIZED_STORYBOARD_CONCURRENCY`     | 2，覆盖所有阶段；单实例限制 1–4   |
| `CUSTOMIZED_STORYBOARD_TIMEOUT_SECONDS` | 300                               |
| `CUSTOMIZED_STORYBOARD_MAX_ATTEMPTS`    | 2，范围 1–3                       |

## 执行与恢复

拆分前历史任务的八阶段为快照、构思、故事、资产目录、镜头、审校、修订、保存。历史任务的连续故事段落合并为不超过 60 秒的请求（故事原段落仍不超过 30 秒），完整保留段落内容，传递完整故事、对象目录及相邻镜头，减少重复请求。分片计划在调用前固定，每个成功分片立即持久化；历史已有固定计划或无固定计划的分片均沿用原边界，避免部署后重做已付费内容。仅历史任务要求总时长与目标最多 1 秒偏差；V2 按真实口播、文字停留及动作容量估时，保留自然节奏余量，不机械追齐参考时长。品牌图片仅存在输入版本引用，不发送给模型。

90 秒租约，每 20 秒心跳；API 每 30 秒检查过期任务，自动恢复最多 3 次领取，之后保留结果并显示失败。取消 / 来源变化 / 项目删除 / 旧 attempt 回调不能发布结果。用户恢复同任务复用成功阶段；再次创作建立新批次。

模型请求按配置有限重试；持续超时、限流及暂时服务故障由任务再退避 15 / 30 秒，仅恢复发生暂时错误的方案，任务总计最多领取 3 次。已发布脚本和成功阶段不重做，永久错误、非法业务结果及审校未通过不无限重试。受保护 API 的网络 / 429 / 5xx 最多重试 6 次且总预算 40 秒；401 / 404 / 409 立即停止，重发保持相同 attempt 和正文。

模型已返回但分片时长、镜头标识或资产引用不合法时，先保存未采用结果，再携带具体结构问题纠正一次。纠正次数随检查点持久化，进程重启不能重置预算。此纠正只验证结构，不以代码猜测语义。

完整故事阶段同样保存未通过的原稿及具体结构问题；总时长、段落上限或 ID 不合法时，模型只修正段落列表一次，完整故事正文保持原样。暂时故障后继续纠正已有稿件，不重新创作故事；纠正后仍不合法则保留失败结果，恢复不能重置预算。已返回的有效修正也先保存再标记阶段成功，防止中间断连重复付费。

审校为独立请求；存在问题最多一次修订和一次独立复核。复核仍有 ERROR 时保留完整检查点，不发布。恢复不会反复付费修订该结果，应调整本次设置重新创作。日志仅记录阶段、模型、token 用量、耗时及错误类型，不输出 Prompt、正文和密钥。

审校及复核的结构化输出 Schema 将可引用镜头 ID 收紧为当前完整脚本的准确枚举。请求层验证并按原有有限预算重试无效响应，避免把“镜头一”等临时名称当作稳定引用；不以代码猜测问题对应镜头，不改变问题严重程度，也不删除问题来凑成成功。

审校、修订和复核同时接收代码计算的完整镜头累计时间轴，辅助核对概述、结构与实际镜头的先后关系。时间计算不改变镜头或业务 revision，事件含义与修改仍由模型判断。长脚本速度及两产品真实付费记录见[性能验收](../../docs/workflows/customized/evidence/2026-10-12-分镜性能优化付费验收.md)。

修订模型仍阅读完整脚本、简报和审校问题，只返回有类型的变更字段及必要的增删镜头，不重复输出正常内容。Worker 校验身份、重复修改、对象引用及总时长，在原稿副本上应用，生成真实前后对照，再将完整修订稿送独立复核。补丁先保存，合成稿再保存；复核临时失败后恢复不重新购买修订，非法补丁也不会因重启无限付费重做。旧的完整修订检查点继续可恢复，API 和前端的完整稿与修订展示契约不变。

## 验证

在本目录运行：

```powershell
uv sync --frozen
uv run pytest
uv run mypy src
```

测试适配器仅在测试中注入，不存在缺配置后转为 Mock 的生产分支。覆盖食品、护肤品、电子、家居及软件输入，1 / 3 / 5 份与 15 / 30 / 180 秒；这些证明结构、隔离和恢复，不证明真实创意质量或供应商模型可用性。

根目录设置 `CUSTOMIZED_STORYBOARD_DATABASE_TEST=1` 后运行 `pnpm --filter @ai-marketing/api exec vitest run src/workflows/customized/storyboard` 可验证真实 PostgreSQL 分支事务。再设置 `CUSTOMIZED_STORYBOARD_HTTP_TEST=1` 可执行真实 API 与 Python 跨层验证：需先启动 API、配置同一独立 Token，并安装本目录 Python 环境；模型适配器仅在测试进程注入，测试禁止投递 Outbox，结束清理随机项目。

跨层验收见[记录](../../docs/workflows/customized/evidence/2026-10-12-分镜生成验收.md)，真实模型验收见[付费记录](../../docs/workflows/customized/evidence/2026-10-12-分镜真实付费验收.md)，脚本 JSON Schema 见 [Contracts](../../packages/contracts/schemas/customized-storyboard-script.schema.json)。

真实模型验收脚本为 `apps/api/scripts/verify-customized-storyboard-paid.mjs`。从根目录显式设置 `CUSTOMIZED_STORYBOARD_PAID_TEST=1`，提供已确认资料所在的 `--project` / `--run` 及独立 `--manifest`，再设置 `--seconds`、`--type`；新建固定一份，不接受其他 `--count`。指定结构使用 `--mode=CUSTOM --structure=段落一→段落二`。再次使用同一 manifest 仅恢复观察；附加 `--retry` 才恢复终态未完成任务。启用运营登录后应通过已有登录浏览器验收，本脚本不绕过鉴权。日志统计 token 与耗时，实际费用以供应商账单为准。

同输入修订性能重放入口为 `scripts/verify_paid_repair.py <本地输入JSON> <本地结果JSON>`，同样要求付费开关及真实 Ark 环境变量。输入包含冻结的 `input`、原始 `script` 与 `review`，只在本地保存补丁、完整修订稿和复核，不修改历史 API 任务。结果文件可恢复，不能把已保存修订的恢复耗时当作首次修订耗时。文档及结果正文不要加入运行日志。

## 脚本 / 资产 / 视频制作拆分（2026-10-12）

新建脚本任务使用 STORY_ONLY：完整故事成功后发布，不在脚本任务中拆资产和镜头。已有不带 outputMode 的任务继续按历史步骤恢复。

资产准备和视频制作各自使用独立 Worker：[customized-assets](../customized-assets/README.md) 只处理 ASSETS，[customized-production](../customized-production/README.md) 只处理 SHOTS / PROMPT。两者拥有独立入口、镜像、锁文件、队列和 Token，共同依赖 shared/customized-production-runtime，不依赖本目录内部模块。本目录 production.py / production_main.py 仅保留兼容入口；production_main 限制为视频制作角色。无 Docling/Torch/视频运行时和解析模型卷。

```powershell
docker compose --profile customized-assets --profile customized-production build customized-assets-worker customized-production-worker
docker compose --profile customized-assets --profile customized-production up -d --no-deps customized-assets-worker customized-production-worker
docker compose --profile customized-assets --profile customized-production ps customized-assets-worker customized-production-worker
```

启动前核对 API 已加载同一 Token，以及无等待/活动任务；启动消费者会消费已有消息。API 使用 `pnpm dev:api`，构建不等于运行进程已更新。首次部署先执行对应数据库 migration。

制作操作为 ASSETS / SHOTS / PROMPT。六个持久化步骤为 SNAPSHOT、PLAN、GENERATE、REVIEW、REPAIR、SAVE；无审校问题时 REPAIR 记录无需修订。长分镜按最多60秒的段落、有界并发2生成，每个成功片段单独保存；恢复复用同任务检查点。每镜 Prompt 仅接收绑定子集。图片字段只保存引用，不送视觉模型。本次不生成图片或视频。

资产结果包含图像制作要求（imageRequirements），这只是后续图片的视角/状态/细节需求。产品、人物、场景、道具分别维护公共定义；Prompt 的引用集合必须等于本镜已确认绑定。AI结果经独立审校；仍有未解决问题不提交。

受控验证：

```powershell
uv run --project workers/customized-storyboard pytest workers/customized-storyboard/tests
uv run --project workers/customized-storyboard mypy workers/customized-storyboard/src/customized_storyboard
$env:CUSTOMIZED_PRODUCTION_DATABASE_TEST='1'
pnpm --filter @ai-marketing/api exec vitest run src/workflows/customized/production/production.database.spec.ts --maxWorkers=1
```

数据库测试创建随机隔离项目并清理，仅使用受控输出，不发送模型任务。Schema 文件位于 packages/contracts/schemas/customized-production-*.schema.json，通过 Python 一致性测试核对。实际模型质量和耗时需单独付费测试，不将受控结果当成真实生成。

独立审校付费对照入口：scripts/verify_paid_typed_review.py，参数依次为冻结正文输入、结果文件、medium/high 对照或 configured 正式阶段配置；需显式付费开关和 Ark 环境变量。只保存本地结果，绝不创建或覆盖项目脚本；同一输入已有结果则只恢复读取。测试结论见[质量复测](../../docs/workflows/customized/evidence/2026-10-13-脚本专项审校与质量复测.md)。

### .11 候选差异与正文审校

上一轮新任务策略为 `2026-10-13.11`。品牌与剧情候选分别从日常观察、观看方式、人物交往等不同开发问题出发，再选择必要的真实产品作用；这些问题不是脚本模板或配额。审校进一步区分常规功能兑现与实际观看发现，核对人为堆叠故障及不必要的参数免责声明。模型配置、调用数量、并发和一次修订上限沿用 .10；.10 及更早仍按独立冻结策略恢复。付费质量结论以本轮验收记录为准。

### 品牌创意开发线路（2026-10-14）

新品牌任务在路由后执行 `BRAND_AD_PROPOSITION`、`BRAND_AD_IDEAS`、`BRAND_AD_CONCEPT`。命题与短创意由一次真实模型调用共同开发并分别持久化；择优为独立调用，逐项评估候选并绑定创意保留清单。弱案最多开发一次替代候选、再择优；预算与产物保存检查点，恢复不重置，仍弱则不写稿。正文/修订/审校消费选中清单，事实审校仍独立，最终自动提交边界不变。

共享Schema为 `customized-brand-development.schema.json` 与 `customized-brand-selection.schema.json`，pytest验证模型一致性；API校验引用、候选覆盖和脚本归属。正常调用数量仍是2+3N，替代开发最多增加2次主要调用；全部调用共用并发上限2。开发与择优输出预算8192，扩容重试16384，不增加无限循环。详见[计划](../../docs/workflows/customized/plans/2026-10-14-品牌广告创意开发线路重构.md)。

`.14.3` 对品牌开发及独立择优采用 high 推理，保留原稿/事实 medium、创意审校 high；其他视频类型的阶段预算不变。历史目录输入保留每份完整概述及记忆点，省略重复辅助字段，开发阶段也据此避重。此配置的实际质量与延迟见[真实验收记录](../../docs/workflows/customized/evidence/2026-10-14-品牌创意线路重构与付费验收.md)，不以提高推理预算宣称质量必然提高。

`.14.3` 实测前期开发 high 推理用尽8192输出token而未返回业务结果，测试已取消。第四轮 `.14.4` 开发恢复 medium，仅独立择优及创意审校使用 high；保留新增的创意证据门槛与完整历史概述输入。`.14.1/.14.2/.14.3` 仍可按任务冻结版本恢复。

`.14.5` 使用 `LeanBrandSelection`，独立选择只输出评价和保留清单；按候选ID直接投影其原始画面与机制为旧结果结构，无第二次语义改写。开发和选择使用medium，独立创意审校仍high；历史完整概述只发给选择阶段。旧`.14.1`至`.14.4`策略仍可恢复。模型输入/输出长度和延迟以安全usage日志与付费验收为准。

`.14.6` 用单一职责指令替代累计追加规则；命题聚焦一个传播认识，展示要求必须有简报原文依据，写作与返修可取舍非必要操作。品牌独立创意审校使用medium，事实审校仍独立执行，错误拦截及一次定向修订/复核不变。其他类型推理预算和历史品牌策略不变。精简择优遇到身份/决策结构错误时保留结果，最多一次机械纠正；仍错则停止，恢复不清空预算。原始非法返回仅作为任务检查点，不作为已选创意或用户正式脚本。

`.14.7` 在品牌开发、择优、正文及独立创意审校统一区分“用途得到解决”与“观看发现成立”：使用完成度不能单独证明品牌概念或中段发展。审校恢复完整可观察校准，具体结论仍由模型依据正文判断，代码不按产品关键词拦截。保持 medium、独立事实检查和最多一次返修复核。旧`.14.6`的规则与已发布结果不回写；真实校准与完整测试的结果及限制见上述验收记录。

### 电商购买动机与价值演示（2026-10-14）

上一轮带货任务冻结`2026-10-14-commerce.4`，品牌仍为`.14.7`，剧情/到店不改。新线路先在`ECOMMERCE_MOTIVATION`开发六份购买动机与演示链，再由`ECOMMERCE_CONCEPT`独立择优；结果原样投影为原脚本计划。每份绑定购买问题、真实事实引用、演示起点/动作/结果/表达边界，不按产品关键词分流。

正文、商业表达、事实/执行与必要的补丁/复核仍复用现有链路，正常N份为2+3N主要调用；弱候选最多替代开发一次（增加两次），每份返修增加三次。模型请求共享并发2，同时推进至多两份脚本，让已进入审校的脚本有机会先完成；每份完整成功就发布，不等待整批。API失败回调携带实际检查点，恢复不丢失已完成的审校侧。

`.1/.2`用Pro开发短方案，`.3`改用任务冻结的detail模型（默认Turbo）中等推理；`.4`仅此短开发及其结构纠正为低推理，独立选择、正文和双审使用creative模型（默认Pro）中等推理。历史版本保持原配置，不能把当前默认作用于旧任务。商业审校以购买疑问确定范围，仍须引用实际正文，不把计划当实现，不要求每份补齐全部卖点。

Schema：`customized-commerce-development.schema.json`、`customized-commerce-selection.schema.json`；API验证来源编号、选择覆盖、脚本身份和原计划投影。前端复用共享工作流图与进度，显示真实动机、全部候选取舍及演示边界。任务完成后进度消失。原`.14.7`及更早带货任务保持原图恢复。详见[计划](../../docs/workflows/customized/plans/2026-10-14-电商购买动机与价值演示线路重构.md)及[真实验收](../../docs/workflows/customized/evidence/2026-10-14-电商动机与价值演示付费验收.md)。

### 当前口播带货线路（2026-10-14）

新 ECOMMERCE 任务冻结 `2026-10-14-presenter.3`，显示名称为口播带货，无二级类型。独立 presenter_development 与 commerce_presenter 策略在原动机/择优节点维护讲述者、推荐逻辑、演示分工及具体创意；正文和审校仍复用任务、双审、一次修订、恢复与自动提交底座。正常2+3N主要调用、短策划Turbo低推理、其余Pro中等推理、并发2不变。新Schema为 `customized-presenter-development.schema.json`，旧Schema与冻结策略保持兼容。见[当前计划](../../docs/workflows/customized/plans/2026-10-14-口播带货创作线路.md)。
