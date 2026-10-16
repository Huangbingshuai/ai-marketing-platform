import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  storyboardStages,
  scriptStrategyVersion,
  COMMERCE_CREATION_VERSIONS,
  DRAMA_CREATION_VERSIONS,
  isDramaStrategy,
  validateDramaDevelopment,
  validateDramaSelection,
  isCommerceStrategy,
  isPresenterStrategy,
  validatePresenterDevelopment,
  validateCommerceDevelopment,
  validateCommerceSelection,
  validateBrandDevelopment,
  validateBrandSelection,
  isSharedScriptStage,
  scriptStageRole,
  validateScriptStructureMapping,
  validateStoryboardCheckpoint,
  isCustomizedBrief,
  isCustomizedStoryboardDraft,
  isCustomizedStoryboardScript,
  storyboardProgress,
  validateStoryboardPublication,
  validateStoryboardScreenplay,
  validateStoryboardVideoScript,
  validateStoryboardSettings,
  type CustomizedStoryboardDraft,
  type StoryboardInput,
  type StoryboardSettings,
  type StoryboardSource,
  type StoryboardTask,
  type StoryboardWorkspace,
  type CustomizedStoryboardScript as Script,
  type StoryboardStep,
  type StoryboardReview,
  type StoryboardFinish,
} from '@ai-marketing/contracts';
import {
  Prisma,
  type CustomizedStoryboardTask,
  type CustomizedStoryboardStep,
  type CustomizedStoryboardScript,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import {
  customizedScope,
  lockCustomizedProject,
  customizedConflict,
} from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ApiHttpException } from '../../../common/api-http-exception';
import { deleteStoryboardScript } from './storyboard-deletion';

const json = (v: unknown) => v as Prisma.InputJsonValue;
const missing = () => new ApiHttpException('分镜记录不存在', 404, 'ASSET_NOT_FOUND');
const invalid = (message: string): never => {
  throw new ApiHttpException(message, 400, 'VALIDATION_ERROR');
};
export function storyboardHistoryConcept(
  scriptId: string,
  value: unknown,
  route?: StoryboardInput['routeId'],
) {
  if (!isCustomizedStoryboardScript(value)) return [];
  if (route && value.creation?.videoType && value.creation.videoType !== route) return [];
  return [{ scriptId, name: value.name, synopsis: value.synopsis }];
}
const defaults: StoryboardSettings = {
  videoType: 'BRAND_AD',
  structureSections: [],
  targetDurationSeconds: 30,
  variantCount: 1,
  structureMode: 'AI',
  structure: '',
  instructions: '',
};
type Task = CustomizedStoryboardTask & { steps: CustomizedStoryboardStep[] };
const inputOf = (t: CustomizedStoryboardTask) => t.inputSnapshot as unknown as StoryboardInput;
export const presentStoryboardTask = (t: Task): StoryboardTask => ({
  ...(inputOf(t).outputMode ? { outputMode: inputOf(t).outputMode! } : {}),
  ...(inputOf(t).graphVersion
    ? {
        graphVersion: inputOf(t).graphVersion!,
        routeId: inputOf(t).routeId!,
        ...(inputOf(t).strategyVersions ? { strategyVersions: inputOf(t).strategyVersions! } : {}),
      }
    : {}),
  id: t.id,
  workflowRunId: t.workflowRunId,
  status: t.status as StoryboardTask['status'],
  progress: storyboardProgress(
    t.steps as Pick<StoryboardStep, 'nodeId' | 'scriptId' | 'status'>[],
    inputOf(t).scriptIds,
    t.status === 'COMPLETED',
    inputOf(t).outputMode === 'STORY_ONLY',
    inputOf(t),
  ),
  steps: t.steps.map((s) => ({
    nodeId: s.nodeId as StoryboardStep['nodeId'],
    scriptId: s.scriptId,
    status: s.status as StoryboardStep['status'],
    errorMessage: s.errorMessage,
    updatedAt: s.updatedAt.toISOString(),
  })),
  errorMessage: t.errorMessage,
  createdAt: t.createdAt.toISOString(),
  updatedAt: new Date(
    Math.max(t.updatedAt.getTime(), ...t.steps.map((s) => s.updatedAt.getTime())),
  ).toISOString(),
});

@Injectable()
export class StoryboardRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}
  private async scope(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    const run = await tx.workflowRun.findFirst({
      where: { ...customizedScope(projectId), id: runId, status: { in: ['ACTIVE', 'PAUSED'] } },
    });
    if (!run) throw missing();
    if (await tx.project.count({ where: { id: projectId, deletionState: { not: null } } }))
      return customizedConflict('项目正在删除');
    return run;
  }
  private async sourceRun(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    const run = await this.scope(tx, projectId, runId);
    if (run.editSessionNodeId) return customizedConflict('请先保存或取消当前节点编辑');
    if (run.forkScriptId) {
      const script = await tx.customizedStoryboardScript.findFirst({
        where: { projectId, id: run.forkScriptId },
      });
      if (!script) throw missing();
      return this.scope(tx, projectId, script.sourceRunId);
    }
    return run;
  }
  private brief(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    return tx.workingArtifact.findFirst({
      where: {
        projectId,
        workflowRunId: runId,
        artifactKey: 'customized-brief',
        availability: 'AVAILABLE',
      },
    });
  }
  private source(b: { id: string; revision: number; contentHash: string }): StoryboardSource {
    return { artifactId: b.id, revision: b.revision, fingerprint: b.contentHash };
  }
  private async state(tx: Prisma.TransactionClient, projectId: string, runId: string) {
    const s = await tx.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId,
          workflowRunId: runId,
          nodeId: 'STORYBOARD_SETTINGS',
        },
      },
    });
    const value = s?.state as unknown as
      { settings?: StoryboardSettings; selectedScriptId?: string | null } | undefined;
    return {
      revision: s?.revision ?? 0,
      // New creation is always single-script. Historical task snapshots retain their own count.
      settings: { ...(value?.settings ?? defaults), variantCount: 1 },
      selectedScriptId: value?.selectedScriptId ?? null,
    };
  }
  async workspace(projectId: string, runId: string): Promise<StoryboardWorkspace> {
    return this.db.$transaction(
      async (tx) => {
        const run = await this.sourceRun(tx, projectId, runId),
          b = await this.brief(tx, projectId, run.id),
          state = await this.state(tx, projectId, run.id);
        const records = await tx.customizedStoryboardScript.findMany({
          where: { projectId },
          orderBy: { createdAt: 'asc' },
        });
        const branches = await tx.workflowRun.findMany({
          where: { projectId, forkScriptId: { in: records.map((s) => s.id) } },
          select: { forkScriptId: true, branchPublishedAt: true },
        });
        const publishedAt = (id: string) =>
          branches.find((b) => b.forkScriptId === id)?.branchPublishedAt?.getTime() ??
          Number.MAX_SAFE_INTEGER;
        records.sort((a, b) => publishedAt(a.id) - publishedAt(b.id));
        const artifacts = await tx.workingArtifact.findMany({
          where: {
            projectId,
            artifactKey: { in: records.map((s) => `customized-script:${s.id}`) },
            availability: 'AVAILABLE',
          },
        });
        const scripts = records
          .filter((s) => s.origin !== 'AI' || s.status === 'COMPLETED')
          .map((s) => {
            const a = artifacts.find(
                (a) =>
                  a.workflowRunId === s.workflowRunId &&
                  a.artifactKey === `customized-script:${s.id}`,
              ),
              source = s.sourceSnapshot as unknown as StoryboardSource;
            return {
              id: s.id,
              workflowRunId: s.workflowRunId,
              source,
              status: s.status as 'DRAFT',
              origin: s.origin as 'AI',
              revision: s.revision,
              editing: s.editing,
              stale:
                !b ||
                b.freshness !== 'CURRENT' ||
                source.artifactId !== b.id ||
                source.revision !== b.revision ||
                a?.freshness === 'STALE',
              script: (s.editing ? s.draft : (a?.payload ?? s.draft)) as unknown as Script,
              confirmedRevision: a?.revision ?? null,
              taskId: s.taskId,
            };
          });
        const task = await tx.customizedStoryboardTask.findFirst({
          where: { projectId, workflowRunId: run.id },
          orderBy: { createdAt: 'desc' },
          include: { steps: true },
        });
        const legacy = await tx.workflowNodeState.findUnique({
          where: {
            projectId_workflowRunId_nodeId: {
              projectId,
              workflowRunId: run.id,
              nodeId: 'STORYBOARD',
            },
          },
        });
        const viewed = await this.scope(tx, projectId, runId);
        return {
          sourceRunId: run.id,
          source: b ? this.source(b) : null,
          brief: b && isCustomizedBrief(b.payload) ? b.payload : null,
          sourceReady: !!b && b.freshness === 'CURRENT' && isCustomizedBrief(b.payload),
          settings: state.settings,
          settingsRevision: state.revision,
          scripts,
          selectedScriptId: scripts.some((s) => s.id === state.selectedScriptId)
            ? state.selectedScriptId
            : scripts.some((s) => s.id === viewed.forkScriptId)
              ? viewed.forkScriptId
              : (scripts[0]?.id ?? null),
          task: task ? presentStoryboardTask(task) : null,
          legacyDraft:
            !records.length && isCustomizedStoryboardDraft(legacy?.state)
              ? (legacy!.state as unknown as CustomizedStoryboardDraft)
              : null,
        };
        // Read-only projection: no advisory/row locks. Keep a bounded budget under
        // concurrent generation instead of expiring the default 5 s transaction.
      },
      { timeout: 15000, maxWait: 3000 },
    );
  }
  async settings(
    projectId: string,
    runId: string,
    expectedRevision: number,
    settings: StoryboardSettings,
    selectedScriptId?: string | null,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const run = await this.sourceRun(tx, projectId, runId),
        old = await this.state(tx, projectId, run.id);
      if (old.revision !== expectedRevision)
        return customizedConflict('创作设置已更新，本地修改仍保留');
      if (
        selectedScriptId &&
        !(await tx.customizedStoryboardScript.count({ where: { projectId, id: selectedScriptId } }))
      )
        throw missing();
      const state = {
          settings: { ...settings, variantCount: 1 },
          selectedScriptId:
            selectedScriptId === undefined ? old.selectedScriptId : selectedScriptId,
        },
        hash = workflowStateHash(state);
      if (
        workflowStateHash({ settings: old.settings, selectedScriptId: old.selectedScriptId }) ===
        hash
      )
        return old.revision;
      const saved = await tx.workflowNodeState.upsert({
        where: {
          projectId_workflowRunId_nodeId: {
            projectId,
            workflowRunId: run.id,
            nodeId: 'STORYBOARD_SETTINGS',
          },
        },
        create: {
          projectId,
          workflowRunId: run.id,
          nodeId: 'STORYBOARD_SETTINGS',
          schemaVersion: 1,
          state: json(state),
          contentHash: hash,
        },
        update: { state: json(state), contentHash: hash, revision: { increment: 1 } },
      });
      return saved.revision;
    });
  }
  async create(
    projectId: string,
    runId: string,
    expectedRevision: number,
    idempotencyKey: string,
    models: StoryboardInput['models'],
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const run = await this.sourceRun(tx, projectId, runId),
        state = await this.state(tx, projectId, run.id);
      const old = await tx.customizedStoryboardTask.findUnique({
        where: { projectId_idempotencyKey: { projectId, idempotencyKey } },
        include: { steps: true },
      });
      if (old) {
        if (old.workflowRunId !== run.id) return customizedConflict('请求标识已用于其他来源');
        return presentStoryboardTask(old);
      }
      if (state.revision !== expectedRevision)
        return customizedConflict('创作设置已变化，请重新加载');
      const error = validateStoryboardSettings(state.settings);
      if (error) invalid(error);
      const b = await this.brief(tx, projectId, run.id);
      if (!b || b.freshness !== 'CURRENT' || !isCustomizedBrief(b.payload))
        return customizedConflict('请先确认有效的视频创作信息卡');
      const active = await tx.customizedStoryboardTask.findFirst({
        where: { projectId, workflowRunId: run.id, status: { in: ['QUEUED', 'RUNNING'] } },
        include: { steps: true },
      });
      if (active) return presentStoryboardTask(active);
      const previous = await tx.customizedStoryboardScript.findMany({
        where: { projectId, status: 'COMPLETED' },
      });
      const confirmed = await tx.workingArtifact.findMany({
        where: {
          projectId,
          artifactKey: { in: previous.map((s) => `customized-script:${s.id}`) },
          availability: 'AVAILABLE',
        },
      });
      const sourcePackage = await tx.workingArtifact.findFirst({
        where: { projectId, workflowRunId: run.id, artifactKey: 'customized-source-package' },
      });
      const materials =
        (sourcePackage?.payload as { materials?: unknown[] } | null)?.materials ?? [];
      const input: StoryboardInput = {
        schemaVersion: 1,
        outputMode: 'STORY_ONLY',
        storyFormat: 'VIDEO_SCRIPT_V3',
        graphVersion: 'TYPED_CREATION_V1',
        routeId: state.settings.videoType ?? 'DRAMA',
        // Freeze strategy versions: a resumed task never adopts a newer creative policy.
        strategyVersions: {
          concept: scriptStrategyVersion(state.settings.videoType ?? 'DRAMA'),
          story: scriptStrategyVersion(state.settings.videoType ?? 'DRAMA'),
          review: scriptStrategyVersion(state.settings.videoType ?? 'DRAMA'),
          repair: scriptStrategyVersion(state.settings.videoType ?? 'DRAMA'),
        },
        source: this.source(b),
        brief: b.payload,
        settings: {
          ...state.settings,
          variantCount: 1,
          videoType: state.settings.videoType ?? 'DRAMA',
          instructions: '',
          structureSections:
            state.settings.structureMode === 'AI'
              ? []
              : (state.settings.structureSections ??
                state.settings.structure
                  .split(/→|\n/)
                  .map((s) => s.trim())
                  .filter(Boolean)),
          structure:
            state.settings.structureMode === 'AI'
              ? ''
              : state.settings.structureSections?.join(' → ') || state.settings.structure,
        },
        scriptIds: [randomUUID()],
        models,
        brandReferences: materials.filter(
          (v) => (v as { category?: string })?.category === 'VISUAL_REFERENCE',
        ),
        existingConcepts: previous.flatMap((s) => {
          const v = confirmed.find(
            (a) =>
              a.workflowRunId === s.workflowRunId && a.artifactKey === `customized-script:${s.id}`,
          )?.payload;
          return storyboardHistoryConcept(s.id, v, state.settings.videoType);
        }),
      };
      const t = await tx.customizedStoryboardTask.create({
        data: {
          projectId,
          workflowRunId: run.id,
          idempotencyKey,
          inputHash: workflowStateHash(input),
          inputSnapshot: json(input),
        },
        include: { steps: true },
      });
      for (const id of input.scriptIds)
        await tx.customizedStoryboardScript.create({
          data: {
            id,
            projectId,
            sourceRunId: run.id,
            taskId: t.id,
            sourceSnapshot: json(input.source),
            origin: 'AI',
            status: 'QUEUED',
            draft: json({
              id,
              name: '',
              synopsis: '',
              structure: '',
              productFocus: '',
              shots: [],
              assets: [],
            }),
          },
        });
      await tx.customizedStoryboardStep.createMany({
        data: storyboardStages(input).flatMap((stage) =>
          (isSharedScriptStage(stage.id) ? [''] : input.scriptIds).map((scriptId) => ({
            projectId,
            taskId: t.id,
            nodeId: stage.id,
            scriptId,
            status: 'PENDING',
          })),
        ),
      });
      await this.enqueue(tx, t);
      return presentStoryboardTask(
        await tx.customizedStoryboardTask.findUniqueOrThrow({
          where: { id: t.id },
          include: { steps: true },
        }),
      );
    });
  }
  private enqueue(tx: Prisma.TransactionClient, t: CustomizedStoryboardTask) {
    return tx.jobOutbox.upsert({
      where: {
        projectId_jobType_aggregateId: {
          projectId: t.projectId,
          jobType: 'CUSTOMIZED_STORYBOARD',
          aggregateId: t.id,
        },
      },
      create: {
        projectId: t.projectId,
        jobType: 'CUSTOMIZED_STORYBOARD',
        aggregateId: t.id,
        routingKey: 'customized.storyboard.requested',
        payload: { schemaVersion: 1, projectId: t.projectId, runId: t.id, requestId: randomUUID() },
      },
      update: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, publishedAt: null },
    });
  }
  async task(projectId: string, id: string): Promise<Task> {
    const t = await this.db.customizedStoryboardTask.findFirst({
      where: { projectId, id },
      include: { steps: true },
    });
    if (!t) throw missing();
    await this.db.$transaction((tx) => this.scope(tx, projectId, t.workflowRunId));
    return t;
  }
  private async validSource(tx: Prisma.TransactionClient, t: CustomizedStoryboardTask) {
    await this.scope(tx, t.projectId, t.workflowRunId);
    const b = await this.brief(tx, t.projectId, t.workflowRunId),
      source = inputOf(t).source;
    if (
      !b ||
      b.freshness !== 'CURRENT' ||
      b.id !== source.artifactId ||
      b.revision !== source.revision ||
      b.contentHash !== source.fingerprint
    )
      return customizedConflict('信息卡来源已变化，请重新创作');
  }
  async claim(projectId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const t = await tx.customizedStoryboardTask.findFirst({
        where: { projectId, id },
        include: { steps: true, scripts: true },
      });
      if (!t) throw missing();
      if (!['QUEUED', 'RUNNING'].includes(t.status)) return { terminal: true };
      if (t.status === 'RUNNING' && t.leaseExpiresAt && t.leaseExpiresAt > new Date())
        return { busy: true };
      try {
        await this.validSource(tx, t);
      } catch (e) {
        if (!(e instanceof ApiHttpException)) throw e;
        await tx.customizedStoryboardTask.update({
          where: { id },
          data: {
            status: 'FAILED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorMessage: '信息卡来源或项目状态已变化，请基于有效信息卡重新创作',
          },
        });
        return { terminal: true };
      }
      const token = randomUUID();
      await tx.customizedStoryboardTask.update({
        where: { id },
        data: {
          status: 'RUNNING',
          attemptToken: token,
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 90000),
        },
      });
      return {
        attemptToken: token,
        input: t.inputSnapshot,
        checkpoints: t.steps.filter(
          (s) => s.output !== null || ['SUCCEEDED', 'SKIPPED'].includes(s.status),
        ),
        completedScriptIds: t.scripts.filter((s) => s.status === 'COMPLETED').map((s) => s.id),
        retryScriptIds: t.autoRetryScriptIds.length ? t.autoRetryScriptIds : null,
      };
    });
  }
  private async lease(tx: Prisma.TransactionClient, projectId: string, id: string, token: string) {
    if (typeof token !== 'string' || !token) return customizedConflict('缺少执行租约');
    await lockCustomizedProject(tx, projectId);
    const t = await tx.customizedStoryboardTask.findFirst({
      where: {
        projectId,
        id,
        attemptToken: token,
        status: 'RUNNING',
        leaseExpiresAt: { gt: new Date() },
      },
    });
    if (!t) return customizedConflict('任务已取消或执行租约失效');
    await this.validSource(tx, t);
    return t;
  }
  heartbeat(projectId: string, id: string, token: string) {
    return this.db.$transaction(async (tx) => {
      await this.lease(tx, projectId, id, token);
      await tx.customizedStoryboardTask.update({
        where: { id },
        data: { leaseExpiresAt: new Date(Date.now() + 90000) },
      });
      return { accepted: true };
    });
  }
  step(projectId: string, id: string, token: string, value: Omit<StoryboardStep, 'updatedAt'>) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, projectId, id, token);
      // A batch may still be running when one published sibling is permanently removed.
      if (value.scriptId && !inputOf(t).scriptIds.includes(value.scriptId))
        return { accepted: true, removed: true };
      if (
        scriptStageRole(value.nodeId) === 'CONCEPT' &&
        value.output &&
        typeof value.output === 'object'
      ) {
        const output = value.output as { concepts?: { scriptId: string }[] };
        if (Array.isArray(output.concepts))
          value = {
            ...value,
            output: {
              ...output,
              concepts: output.concepts.filter((c) => inputOf(t).scriptIds.includes(c.scriptId)),
            },
          };
      }
      if (inputOf(t).outputMode === 'STORY_ONLY' && ['ASSETS', 'SHOTS'].includes(value.nodeId))
        invalid('完整故事任务不执行资产整理或分镜');
      if (
        !storyboardStages(inputOf(t)).some((s) => s.id === value.nodeId) ||
        (isSharedScriptStage(value.nodeId)
          ? value.scriptId !== ''
          : !inputOf(t).scriptIds.includes(value.scriptId))
      )
        invalid('执行节点或方案不属于当前任务');
      if (value.nodeId === 'SAVE') invalid('保存阶段只能由服务端提交');
      if (value.status === 'SKIPPED' && !['REPAIR', 'RECHECK'].includes(value.nodeId))
        invalid('此阶段不能跳过');
      if (
        value.status === 'SUCCEEDED' &&
        !validateStoryboardCheckpoint(value.nodeId, value.output, inputOf(t), value.scriptId)
      )
        invalid('阶段结果结构不完整');
      if (Buffer.byteLength(JSON.stringify(value.output ?? null)) > 2 * 1024 * 1024)
        invalid('阶段结果超过大小限制');
      if (
        !inputOf(t).graphVersion &&
        value.status === 'SUCCEEDED' &&
        ['REVIEW', 'REPAIR'].includes(value.nodeId)
      ) {
        const output = value.output as { script?: Script; review?: StoryboardReview };
        const reviewedScript =
          value.nodeId === 'REPAIR'
            ? output.script
            : ((
                await tx.customizedStoryboardStep.findUnique({
                  where: {
                    projectId_taskId_nodeId_scriptId: {
                      projectId,
                      taskId: id,
                      scriptId: value.scriptId,
                      nodeId: 'SHOTS',
                    },
                  },
                })
              )?.output as unknown as Script);
        const review =
          value.nodeId === 'REPAIR' ? output.review! : (value.output as StoryboardReview);
        if (
          (inputOf(t).outputMode !== 'STORY_ONLY' && !reviewedScript?.shots) ||
          review.findings.some((f) =>
            f.shotIds.some((id) => !reviewedScript?.shots?.some((s) => s.id === id)),
          )
        )
          invalid('审校引用了未知镜头');
      }
      if (
        inputOf(t).graphVersion === 'TYPED_CREATION_V1' &&
        ['SUCCEEDED', 'SKIPPED'].includes(value.status)
      ) {
        const input = inputOf(t),
          role = scriptStageRole(value.nodeId);
        const all = await tx.customizedStoryboardStep.findMany({
          where: { projectId, taskId: id },
        });
        const find = (node: string) =>
          all.find(
            (s) =>
              s.nodeId === node && s.scriptId === (isSharedScriptStage(node) ? '' : value.scriptId),
          );
        const stages = storyboardStages(input),
          index = stages.findIndex((s) => s.id === value.nodeId);
        if (
          index > 0 &&
          !['SUCCEEDED', 'SKIPPED'].includes(find(stages[index - 1]!.id)?.status ?? '')
        )
          invalid('前置阶段尚未完成');
        if (
          value.nodeId === 'BRAND_AD_CONCEPT' &&
          value.status === 'SUCCEEDED' &&
          [
            '2026-10-14.1',
            '2026-10-14.2',
            '2026-10-14.3',
            '2026-10-14.4',
            '2026-10-14.5',
            '2026-10-14.6',
            '2026-10-14.7',
          ].includes(input.strategyVersions?.concept ?? '')
        ) {
          const decision = value.output as Record<string, unknown>;
          const development = decision.redevelopment ?? find('BRAND_AD_IDEAS')?.output;
          if (
            !validateBrandDevelopment(
              development,
              input.brief,
              Math.min(8, Math.max(6, input.scriptIds.length + 3)),
            ) ||
            !validateBrandSelection(decision, development, input.scriptIds, input.brief)
          )
            invalid('品牌创意选择或事实引用无效');
        }
        if (
          value.nodeId === 'ECOMMERCE_CONCEPT' &&
          value.status === 'SUCCEEDED' &&
          isCommerceStrategy(input.strategyVersions?.concept)
        ) {
          const decision = value.output as Record<string, unknown>;
          const development = decision.redevelopment ?? find('ECOMMERCE_MOTIVATION')?.output;
          if (
            !validateCommerceDevelopment(development, input.brief) ||
            (isPresenterStrategy(input.strategyVersions?.concept) &&
              !validatePresenterDevelopment(development, input.brief)) ||
            !validateCommerceSelection(decision, development, input.scriptIds)
          )
            invalid('口播讲述、演示依据或方案归属无效');
        }
        if (
          value.nodeId === 'DRAMA_CONCEPT' &&
          value.status === 'SUCCEEDED' &&
          isDramaStrategy(input.strategyVersions?.concept)
        ) {
          const decision = value.output as Record<string, unknown>;
          if (
            !validateDramaDevelopment(decision.development, input.brief, input.scriptIds.length) ||
            !validateDramaSelection(decision, decision.development, input.scriptIds)
          )
            invalid('剧情开发、事实依据或独立择优结果无效');
        }
        if (role === 'STORY') {
          const planning = find(`${input.routeId}_CONCEPT`)?.output as {
            readiness?: { status?: string };
          } | null;
          if (planning?.readiness?.status !== 'READY') invalid('创作依据不足，不能提交正文');
        }
        if (['REPAIR', 'RECHECK'].includes(value.nodeId)) {
          const initial = find(`${input.routeId}_REVIEW`)?.output as unknown as StoryboardReview;
          const needsRepair = initial?.findings?.some((f) => f.severity === 'ERROR');
          if ((value.status === 'SKIPPED') === !!needsRepair) invalid('修订状态与审校结论不一致');
        }
        if (value.status === 'SUCCEEDED' && (role === 'REVIEW' || value.nodeId === 'RECHECK')) {
          const body = (
            value.nodeId === 'RECHECK'
              ? (find('REPAIR')?.output as unknown as { script?: Script })?.script?.story
              : find(`${input.routeId}_STORY`)?.output
          ) as Script['story'];
          const review = value.output as StoryboardReview;
          if (
            !body ||
            ([
              ...COMMERCE_CREATION_VERSIONS,
              ...DRAMA_CREATION_VERSIONS,
              '2026-10-14.7',
              '2026-10-13.4',
              '2026-10-13.5',
              '2026-10-13.6',
              '2026-10-13.7',
              '2026-10-13.8',
              '2026-10-13.9',
              '2026-10-13.10',
              '2026-10-13.11',
              '2026-10-14.1',
              '2026-10-14.2',
              '2026-10-14.3',
              '2026-10-14.4',
              '2026-10-14.5',
              '2026-10-14.6',
            ].includes(input.strategyVersions?.review ?? '') &&
              review.qualityChecks?.some(
                (check) =>
                  check.beatIds.some((id) => !body.beats.some((b) => b.id === id)) ||
                  (check.verdict !== 'NOT_APPLICABLE' &&
                    !check.beatIds.some((id) =>
                      body.beats.find((b) => b.id === id)?.content.includes(check.evidence),
                    )) ||
                  (check.verdict === 'FAIL' &&
                    !review.findings.some(
                      (finding) =>
                        finding.severity === 'ERROR' &&
                        finding.evidence === check.evidence &&
                        JSON.stringify(finding.beatIds) === JSON.stringify(check.beatIds),
                    )),
              )) ||
            review.findings.some(
              (f) =>
                f.shotIds.length ||
                !f.beatIds ||
                f.beatIds.some((id) => !body.beats.some((b) => b.id === id)),
            )
          )
            invalid('审校引用了未知正文篇章');
        }
      }
      const key = { projectId, taskId: id, nodeId: value.nodeId, scriptId: value.scriptId };
      const old = await tx.customizedStoryboardStep.findUnique({
        where: { projectId_taskId_nodeId_scriptId: key },
      });
      if (old && ['SUCCEEDED', 'SKIPPED'].includes(old.status)) return { accepted: true };
      await tx.customizedStoryboardStep.upsert({
        where: { projectId_taskId_nodeId_scriptId: key },
        create: {
          ...key,
          status: value.status,
          output: value.output === null ? Prisma.JsonNull : json(value.output),
          errorMessage: value.errorMessage,
        },
        update: {
          status: value.status,
          ...(value.output === null ? {} : { output: json(value.output) }),
          errorMessage: value.errorMessage,
        },
      });
      return { accepted: true };
    });
  }
  private async publish(
    tx: Prisma.TransactionClient,
    s: CustomizedStoryboardScript,
    script: Script,
  ) {
    const b = await this.brief(tx, s.projectId, s.sourceRunId),
      source = s.sourceSnapshot as unknown as StoryboardSource;
    if (
      !b ||
      b.freshness !== 'CURRENT' ||
      b.id !== source.artifactId ||
      b.revision !== source.revision
    )
      return customizedConflict('脚本来源已变化，请重新创作');
    let runId = s.workflowRunId;
    if (!runId) {
      const branch = await tx.workflowRun.create({
        data: {
          ...customizedScope(s.projectId),
          activeKey: null,
          status: 'PAUSED',
          parentWorkflowRunId: s.sourceRunId,
          forkNodeId: 'STORYBOARD',
          forkScriptId: s.id,
          branchLabel: script.name,
          branchCreationKey: `script:${s.id}`,
          currentNodeId: 'STORYBOARD',
          branchPublishedAt: new Date(),
        },
      });
      runId = branch.id;
      // Copy immutable upstream ownership, retaining original identity and exact revision.
      const originals = await tx.workingArtifact.findMany({
        where: {
          projectId: s.projectId,
          workflowRunId: s.sourceRunId,
          nodeId: { in: ['SOURCE_IMPORT', 'INFORMATION_EXTRACTION'] },
        },
        include: { dependencies: true, files: true },
      });
      const ids = new Map<string, string>();
      for (const a of originals) {
        const { id, dependencies: _d, files: _f, updatedAt: _u, ...data } = a;
        void _d;
        void _f;
        void _u;
        const copy = await tx.workingArtifact.create({
          data: {
            ...data,
            workflowRunId: runId,
            sourceArtifactId: a.sourceArtifactId ?? id,
            sourceRunId: a.sourceRunId ?? s.sourceRunId,
            payload: json(a.payload),
            metadata: a.metadata === null ? Prisma.JsonNull : json(a.metadata),
          },
        });
        ids.set(id, copy.id);
      }
      for (const a of originals) {
        for (const d of a.dependencies) {
          const { id: _id, ...data } = d;
          void _id;
          await tx.workingArtifactDependency.create({
            data: {
              ...data,
              workflowRunId: runId,
              dependentArtifactId: ids.get(a.id)!,
              sourceArtifactId: d.sourceArtifactId
                ? (ids.get(d.sourceArtifactId) ?? d.sourceArtifactId)
                : null,
            },
          });
        }
        for (const f of a.files) {
          const { id: _id, ...data } = f;
          void _id;
          await tx.workingArtifactFile.create({
            data: { ...data, workflowRunId: runId, workingArtifactId: ids.get(a.id)! },
          });
        }
        await tx.workingArtifactDependency.create({
          data: {
            projectId: s.projectId,
            workflowRunId: runId,
            dependentArtifactId: ids.get(a.id)!,
            sourceType: 'WORKING_ARTIFACT',
            sourceArtifactId: a.id,
            sourceNodeId: a.nodeId,
            sourceKey: a.artifactKey,
            sourceRevision: a.revision,
            sourceHash: a.contentHash,
          },
        });
      }
    }
    const localBrief = await this.brief(tx, s.projectId, runId);
    if (!localBrief || localBrief.revision !== source.revision)
      return customizedConflict('脚本分支来源不匹配');
    const [result] = await this.working.commitValidatedArtifactsInTransaction(
      tx,
      s.projectId,
      runId,
      'STORYBOARD',
      [
        {
          artifactKey: `customized-script:${s.id}`,
          input: {
            kind: 'STRUCTURED',
            name: script.name,
            directory: 'SCRIPTS',
            type: 'STORYBOARD_SCRIPT',
            payload: script,
            dependencies: [
              {
                sourceType: 'WORKING_ARTIFACT',
                sourceArtifactId: localBrief.id,
                sourceNodeId: 'INFORMATION_EXTRACTION',
                sourceKey: 'customized-brief',
                sourceRevision: source.revision,
                sourceHash: source.fingerprint,
              },
            ],
          },
        },
      ],
    );
    await tx.workflowRun.update({ where: { id: runId }, data: { branchLabel: script.name } });
    await tx.customizedStoryboardScript.update({
      where: { id: s.id },
      data: {
        workflowRunId: runId,
        draft: json(script),
        status: 'COMPLETED',
        editing: false,
        revision: { increment: 1 },
      },
    });
    return { workflowRunId: runId, unchanged: result!.unchanged };
  }
  completeScript(projectId: string, taskId: string, token: string, script: Script) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, projectId);
        const s = await tx.customizedStoryboardScript.findFirst({
          where: { projectId, taskId, id: script.id },
        });
        const t = await this.lease(tx, projectId, taskId, token),
          input = inputOf(t);
        if (!s && !input.scriptIds.includes(script.id))
          return { workflowRunId: null, unchanged: true, removed: true };
        if (!s) throw missing();
        if (s.status === 'COMPLETED') return { workflowRunId: s.workflowRunId, unchanged: true };
        const error = validateStoryboardPublication(
          script,
          ['VIDEO_SCRIPT_V2', 'VIDEO_SCRIPT_V3'].includes(input.storyFormat ?? '')
            ? undefined
            : input.settings.targetDurationSeconds,
        );
        if (error) invalid(error);
        if (['VIDEO_SCRIPT_V2', 'VIDEO_SCRIPT_V3'].includes(input.storyFormat ?? '')) {
          if (!script.story) invalid('完整剧本正文尚未生成');
          const formatError = validateStoryboardVideoScript(
            script.story!,
            input.graphVersion ? [] : input.settings.structureSections,
          );
          if (formatError) invalid(formatError);
          if (input.graphVersion) {
            const mappingError = validateScriptStructureMapping(
              script.story!,
              input.settings.structureSections ?? [],
            );
            if (mappingError) invalid(mappingError);
          }
          if (
            script.creation?.videoType !== input.settings.videoType ||
            script.creation?.referenceDurationSeconds !== input.settings.targetDurationSeconds ||
            JSON.stringify(script.creation?.structureSections) !==
              JSON.stringify(input.settings.structureSections)
          )
            invalid('脚本创作设置与输入快照不一致');
        }
        if (input.outputMode === 'STORY_ONLY' && input.storyFormat === 'SCREENPLAY_V1') {
          if (!script.story) invalid('完整剧本正文尚未生成');
          const formatError = validateStoryboardScreenplay(script.story!);
          if (formatError) invalid(formatError);
        }
        if (
          input.outputMode === 'STORY_ONLY' &&
          (!script.story || script.shots.length || script.assets?.length)
        )
          invalid('当前任务只接受完整故事');
        const steps = await tx.customizedStoryboardStep.findMany({ where: { projectId, taskId } });
        for (const stage of storyboardStages(input).filter((n) => n.id !== 'SAVE')) {
          const step = steps.find(
            (v) =>
              v.nodeId === stage.id &&
              v.scriptId === (isSharedScriptStage(stage.id) ? '' : script.id),
          );
          if (!step || !['SUCCEEDED', 'SKIPPED'].includes(step.status))
            return customizedConflict('脚本执行尚未完整完成');
        }
        const repair = steps.find((s) => s.nodeId === 'REPAIR' && s.scriptId === script.id)!;
        const review = (
          repair.status === 'SKIPPED'
            ? steps.find(
                (s) =>
                  s.nodeId === (input.graphVersion ? `${input.routeId}_REVIEW` : 'REVIEW') &&
                  s.scriptId === script.id,
              )!.output
            : input.graphVersion
              ? steps.find((s) => s.nodeId === 'RECHECK' && s.scriptId === script.id)?.output
              : (repair.output as { review?: unknown })?.review
        ) as StoryboardReview;
        if (
          !review ||
          !Array.isArray(review.findings) ||
          review.findings.some((f) => f.severity === 'ERROR')
        )
          return customizedConflict('脚本仍有待处理问题');
        const checkpoint =
          repair.status === 'SKIPPED'
            ? input.outputMode === 'STORY_ONLY'
              ? {
                  ...script,
                  story: steps.find(
                    (s) =>
                      s.nodeId === (input.graphVersion ? `${input.routeId}_STORY` : 'STORY') &&
                      s.scriptId === script.id,
                  )!.output,
                }
              : steps.find((s) => s.nodeId === 'SHOTS' && s.scriptId === script.id)!.output
            : (repair.output as { script?: unknown }).script;
        if (workflowStateHash(script) !== workflowStateHash(checkpoint))
          return customizedConflict('提交内容与已审校脚本不一致');
        const result = await this.publish(tx, s, script);
        await tx.customizedStoryboardScript.update({
          where: { id: s.id },
          data: { generated: json(script) },
        });
        await tx.customizedStoryboardStep.upsert({
          where: {
            projectId_taskId_nodeId_scriptId: { projectId, taskId, scriptId: s.id, nodeId: 'SAVE' },
          },
          create: {
            projectId,
            taskId,
            scriptId: s.id,
            nodeId: 'SAVE',
            status: 'SUCCEEDED',
            output: json({ name: script.name, scriptId: s.id, ...result }),
          },
          update: {
            status: 'SUCCEEDED',
            output: json({ name: script.name, scriptId: s.id, ...result }),
          },
        });
        return result;
      },
      { timeout: 30000 },
    );
  }
  finish(projectId: string, id: string, token: string, failure: StoryboardFinish = {}) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const old = await tx.customizedStoryboardTask.findFirst({
        where: { projectId, id, attemptToken: token },
      });
      if (old && ['COMPLETED', 'PARTIAL', 'FAILED', 'QUEUED'].includes(old.status))
        return { accepted: true };
      const t = await this.lease(tx, projectId, id, token),
        count = await tx.customizedStoryboardScript.count({
          where: { projectId, taskId: id, status: 'COMPLETED' },
        });
      const retryIds = [...new Set(failure.retryScriptIds ?? [])].filter((scriptId) =>
        inputOf(t).scriptIds.includes(scriptId),
      );
      const concept = inputOf(t).graphVersion
        ? await tx.customizedStoryboardStep.findFirst({
            where: { projectId, taskId: id, nodeId: `${inputOf(t).routeId}_CONCEPT`, scriptId: '' },
          })
        : null;
      const readiness = (
        concept?.output as { readiness?: { status: string; missing: string[] } } | null
      )?.readiness;
      const informationError =
        readiness?.status === 'NEEDS_INFORMATION'
          ? `请补充创作依据：${readiness.missing.join('、')}`.slice(0, 1000)
          : null;
      const automatic =
        failure.retryable === true && count < inputOf(t).scriptIds.length && t.attemptCount < 3;
      await tx.customizedStoryboardTask.update({
        where: { id },
        data: {
          status: automatic
            ? 'QUEUED'
            : count === inputOf(t).scriptIds.length
              ? 'COMPLETED'
              : count
                ? 'PARTIAL'
                : 'FAILED',
          leaseExpiresAt: null,
          autoRetryScriptIds: automatic ? retryIds : [],
          errorMessage: automatic
            ? '服务暂时繁忙，稍后自动恢复未完成方案；已完成内容保留'
            : count === inputOf(t).scriptIds.length
              ? null
              : (informationError ?? '部分脚本未完成，已成功的脚本保留，可重试未完成部分'),
        },
      });
      if (automatic) {
        await tx.customizedStoryboardStep.updateMany({
          where: {
            projectId,
            taskId: id,
            status: { in: ['RUNNING', 'FAILED'] },
            ...(retryIds.length ? { OR: [{ scriptId: { in: retryIds } }, { scriptId: '' }] } : {}),
          },
          data: { status: 'PENDING', errorMessage: null },
        });
        const outbox = await this.enqueue(tx, t);
        await tx.jobOutbox.update({
          where: { id: outbox.id },
          data: { nextAttemptAt: new Date(Date.now() + 15000 * t.attemptCount) },
        });
      }
      return { accepted: true };
    });
  }
  retry(projectId: string, id: string, cancel = false) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const t = await tx.customizedStoryboardTask.findFirst({ where: { projectId, id } });
      if (!t) throw missing();
      await this.scope(tx, projectId, t.workflowRunId);
      if (cancel) {
        if (['QUEUED', 'RUNNING'].includes(t.status))
          await tx.customizedStoryboardTask.update({
            where: { id },
            data: { status: 'CANCELLED', attemptToken: null, leaseExpiresAt: null },
          });
      } else {
        if (!['FAILED', 'PARTIAL', 'CANCELLED'].includes(t.status)) return { accepted: true };
        await this.validSource(tx, t);
        await tx.customizedStoryboardTask.update({
          where: { id },
          data: {
            status: 'QUEUED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorMessage: null,
            autoRetryScriptIds: [],
          },
        });
        await tx.customizedStoryboardStep.updateMany({
          where: { projectId, taskId: id, status: 'RUNNING' },
          data: { status: 'PENDING' },
        });
        await this.enqueue(tx, t);
      }
      return { accepted: true };
    });
  }
  manual(projectId: string, runId: string, script: Script, origin: 'MANUAL' | 'IMPORT') {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, projectId);
      const run = await this.sourceRun(tx, projectId, runId),
        b = await this.brief(tx, projectId, run.id);
      if (!b || b.freshness !== 'CURRENT') return customizedConflict('请先确认有效信息卡');
      if (!isCustomizedStoryboardScript(script)) invalid('脚本格式不正确');
      const old = await tx.customizedStoryboardScript.findFirst({
        where: { projectId, id: script.id },
      });
      if (old) {
        if (old.sourceRunId !== run.id) return customizedConflict('脚本身份已存在');
        return old;
      }
      return tx.customizedStoryboardScript.create({
        data: {
          id: script.id,
          projectId,
          sourceRunId: run.id,
          sourceSnapshot: json(this.source(b)),
          draft: json(script),
          origin,
          editing: true,
        },
      });
    });
  }
  remove(projectId: string, scriptId: string, runId: string, revision: number) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, projectId);
        await this.scope(tx, projectId, runId);
        return deleteStoryboardScript(tx, projectId, scriptId, revision);
      },
      { timeout: 30000 },
    );
  }
  edit(
    projectId: string,
    scriptId: string,
    action: 'begin' | 'draft' | 'cancel' | 'save' | 'discard',
    expectedRevision: number,
    script?: Script,
  ) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, projectId);
        const s = await tx.customizedStoryboardScript.findFirst({
          where: { projectId, id: scriptId },
        });
        if (!s) throw missing();
        await this.scope(tx, projectId, s.sourceRunId);
        if (s.revision !== expectedRevision)
          return customizedConflict('脚本已在其他窗口更新，本地修改仍保留');
        if (action === 'discard') {
          if (
            s.workflowRunId ||
            s.status !== 'DRAFT' ||
            (s.draft as unknown as Script).shots.length
          )
            return customizedConflict('仅可删除尚未发布的空白脚本');
          await tx.customizedStoryboardScript.delete({ where: { id: s.id } });
          return { discarded: true };
        }
        if (action === 'begin') {
          if (!['DRAFT', 'COMPLETED'].includes(s.status)) return customizedConflict('脚本仍在生成');
          return s.editing
            ? s
            : tx.customizedStoryboardScript.update({
                where: { id: scriptId },
                data: { editing: true, revision: { increment: 1 } },
              });
        }
        if (!s.editing) return customizedConflict('请先进入脚本编辑');
        if (action === 'cancel') {
          const artifact = s.workflowRunId
            ? await tx.workingArtifact.findFirst({
                where: {
                  projectId,
                  workflowRunId: s.workflowRunId,
                  artifactKey: `customized-script:${s.id}`,
                },
              })
            : null;
          return tx.customizedStoryboardScript.update({
            where: { id: s.id },
            data: {
              editing: false,
              draft: artifact?.payload
                ? json(artifact.payload)
                : (s.draft as Prisma.InputJsonValue),
              revision: { increment: 1 },
            },
          });
        }
        if (!script || script.id !== s.id || !isCustomizedStoryboardScript(script))
          invalid('脚本内容不正确');
        if (action === 'draft')
          return workflowStateHash(script) === workflowStateHash(s.draft)
            ? s
            : tx.customizedStoryboardScript.update({
                where: { id: s.id },
                data: { draft: json(script), revision: { increment: 1 } },
              });
        const error = validateStoryboardPublication(script);
        if (error) invalid(error);
        return this.publish(tx, s, script!);
      },
      { timeout: 30000 },
    );
  }
  async recoverExpired() {
    const tasks = await this.db.customizedStoryboardTask.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      take: 20,
    });
    for (const t of tasks)
      await this.db.$transaction(async (tx) => {
        await lockCustomizedProject(tx, t.projectId);
        const result = await tx.customizedStoryboardTask.updateMany({
          where: {
            id: t.id,
            status: 'RUNNING',
            attemptToken: t.attemptToken,
            leaseExpiresAt: { lt: new Date() },
          },
          data: {
            status: t.attemptCount < 3 ? 'QUEUED' : 'FAILED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorMessage: '执行中断，可重试恢复',
          },
        });
        if (result.count) {
          await tx.customizedStoryboardStep.updateMany({
            where: { projectId: t.projectId, taskId: t.id, status: 'RUNNING' },
            data: { status: t.attemptCount < 3 ? 'PENDING' : 'FAILED' },
          });
          if (t.attemptCount < 3) await this.enqueue(tx, t);
        }
      });
  }
}
