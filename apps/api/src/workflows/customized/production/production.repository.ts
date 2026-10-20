import { createAssetBranch } from './production-asset-branch';
import { applyImageOnlyPlanRebase } from './image-only-plan-rebase';
import { beginPromptMechanicalRecovery } from './prompt-mechanical-recovery';
import {
  assertWorkerOperation,
  productionQueue,
  type ProductionWorkerNode,
} from './production-worker-policy';
import { randomUUID } from 'node:crypto';
import { assetExecutionDetail } from './asset-execution-detail';
import { videoExecutionDetail } from './video-execution-detail';
import { freezeVideoRender, renderSettingsNode, videoFileIssues } from './video-render.domain';
import {
  candidateDocument,
  candidateForPreview,
  clipPayload,
  mergeVideoSection,
  normalizeVideoPolicy,
  validateFinalVideo,
  validateFinalClipPrompt,
  validateVideoSnapshot,
  videoHash,
} from './video-production.domain';
import {
  recordAssetEdits,
  mergePreparedAssets,
  validatePreparedAssets,
} from './asset-preparation.domain';
import { Inject, Injectable } from '@nestjs/common';
import {
  isCustomizedStoryboardScript,
  isVideoDocument,
  productionShots,
  withProductionAssets,
  isProductionClipPrompt,
  validateClipPromptReferences,
  isVideoDurationPolicy,
  buildVideoSourceUnits,
  CUSTOMIZED_VIDEO_STRATEGY,
  CUSTOMIZED_VIDEO_LIMITS,
  videoReadableText,
  videoClipAssetIds,
  type ProductionClipPrompt,
  type ProductionPromptValue,
  type ProductionVideoDocument,
  type VideoDurationPolicy,
  type ProductionShot,
  type VideoAudit,
  type VideoCandidate,
  isProductionDocument,
  isProductionPrompt,
  isCustomizedImageSettings,
  customizedAssetImageSelectionIssue,
  isCustomizedVideoRenderSettings,
  type CustomizedVideoRenderSettings,
  type CustomizedVideoResult,
  type CustomizedVideoFileInfo,
  normalizeCustomizedImportDraft,
  CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES,
  type CustomizedImageSettings,
  productionStages,
  type ProductionDocument,
  type ProductionOperation,
  type ProductionWorkspace,
  type ProductionTask,
  type ProductionStep,
  type ProductionInput,
} from '@ai-marketing/contracts';
import type {
  Prisma,
  CustomizedProductionTask,
  WorkingArtifact,
} from '../../../generated/prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AssetRepository } from '../../../platform/asset/asset.repository';
import { WorkflowWorkingRepository } from '../../../platform/workflow/workflow-working.repository';
import {
  customizedScope,
  lockCustomizedProject,
  customizedConflict,
} from '../../../platform/workflow/customized-branches';
import { workflowStateHash } from '../../../platform/workflow/workflow-state-hash';
import { ApiHttpException } from '../../../common/api-http-exception';

const json = (v: unknown) => v as Prisma.InputJsonValue;
const invalid = (m: string): never => {
  throw new ApiHttpException(m, 400, 'VALIDATION_ERROR');
};
const missing = (): never => {
  throw new ApiHttpException('制作记录不存在', 404, 'ASSET_NOT_FOUND');
};
type Tx = Prisma.TransactionClient;
type Snapshot = ProductionInput;
const snapshot = (t: CustomizedProductionTask) => t.inputSnapshot as unknown as Snapshot;
export const presentProductionTask = (t: CustomizedProductionTask): ProductionTask => {
  const steps = t.steps as unknown as ProductionStep[];
  const saved = t.output as Record<string, unknown> | null;
  return {
    id: t.id,
    operation: t.operation as ProductionOperation,
    shotId: t.shotId,
    status: t.status as ProductionTask['status'],
    errorMessage: t.errorMessage,
    ...(typeof saved?.publishedWorkflowRunId === 'string'
      ? { publishedWorkflowRunId: saved.publishedWorkflowRunId }
      : {}),
    ...(t.status === 'FAILED' && t.operation === 'ASSETS' && Array.isArray(saved?.revised)
      ? {
          reviewDraftState: saved.manualDraftAdoptedRevision
            ? ('ADOPTED' as const)
            : ('AVAILABLE' as const),
        }
      : {}),
    ...(snapshot(t).imageSettings ? { imageSettings: snapshot(t).imageSettings } : {}),
    ...(snapshot(t).videoRender
      ? {
          renderSettings: snapshot(t).videoRender!.settings,
          target: { kind: 'CLIP' as const, id: snapshot(t).videoRender!.clipId },
        }
      : {}),
    ...(snapshot(t).shotWorkflowVersion
      ? {
          shotWorkflowVersion: snapshot(t).shotWorkflowVersion,
          ...(snapshot(t).promptWorkflowVersion
            ? { promptWorkflowVersion: snapshot(t).promptWorkflowVersion }
            : {}),
          hasCandidate: !!candidateForPreview(saved),
          target: snapshot(t).target,
          ...(saved?.failureReason
            ? { failureReason: saved.failureReason as NonNullable<ProductionTask['failureReason']> }
            : {}),
          ...(t.status === 'FAILED' && t.operation === 'SHOTS' && candidateDocument(saved)
            ? {
                reviewDraftState: saved?.manualDraftAdoptedRevision
                  ? ('ADOPTED' as const)
                  : ('AVAILABLE' as const),
              }
            : {}),
        }
      : {}),
    steps: steps.map((step) => {
      const detail =
        videoExecutionDetail(step, snapshot(t), t.output) ??
        assetExecutionDetail(step, snapshot(t), t.output);
      return detail ? { ...step, detail } : step;
    }),
    ...(snapshot(t).assetWorkflowVersion
      ? {
          assetWorkflowVersion: snapshot(t).assetWorkflowVersion,
          targetAssetId: snapshot(t).targetAssetId,
        }
      : {}),
    progress:
      t.status === 'COMPLETED'
        ? 100
        : snapshot(t).shotWorkflowVersion === 2
          ? Math.min(
              99,
              Math.round(
                steps.reduce(
                  (n, s) =>
                    n +
                    (s.status === 'SUCCEEDED'
                      ? ((
                          {
                            SNAPSHOT: 5,
                            PLAN: 20,
                            GENERATE: 40,
                            REVIEW: 20,
                            REPAIR: 10,
                            SAVE: 5,
                          } as Record<string, number>
                        )[s.id] ?? 0)
                      : s.id === 'GENERATE' &&
                          Array.isArray(saved?.completedBatches) &&
                          typeof saved?.batchCount === 'number'
                        ? (40 * saved.completedBatches.length) / Math.max(1, saved.batchCount)
                        : 0),
                  0,
                ),
              ),
            )
          : t.operation === 'IMAGE'
            ? Math.min(
                99,
                Math.round(
                  steps.filter((s) => s.id === 'SNAPSHOT' && s.status === 'SUCCEEDED').length * 10 +
                    (Object.keys((t.output ?? {}) as object).length /
                      Math.max(1, snapshot(t).imageSettings?.assetIds.length ?? 1)) *
                      85,
                ),
              )
            : Math.min(
                99,
                Math.round(
                  (steps.filter((s) => s.status === 'SUCCEEDED').length * 100) /
                    Math.max(1, steps.length),
                ),
              ),
  };
};
@Injectable()
export class ProductionRepository {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(WorkflowWorkingRepository) private readonly working: WorkflowWorkingRepository,
  ) {}
  private async scope(tx: Tx, p: string, r: string) {
    const run = await tx.workflowRun.findFirst({
      where: { ...customizedScope(p), id: r, status: { in: ['ACTIVE', 'PAUSED'] } },
    });
    if (!run || !run.forkScriptId) return missing();
    if (
      run.editSessionNodeId ||
      (await tx.project.count({ where: { id: p, deletionState: { not: null } } }))
    )
      return customizedConflict('项目正在编辑或删除');
    return run;
  }
  private artifacts(tx: Tx, p: string, r: string) {
    return tx.workingArtifact.findMany({
      where: { projectId: p, workflowRunId: r, availability: 'AVAILABLE' },
    });
  }
  private async state(tx: Tx, p: string, r: string) {
    return tx.workflowNodeState.findUnique({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId: p,
          workflowRunId: r,
          nodeId: 'CUSTOMIZED_PRODUCTION_DRAFT',
        },
      },
    });
  }
  private async read(tx: Tx, p: string, r: string): Promise<ProductionWorkspace> {
    const run = await this.scope(tx, p, r),
      artifacts = await this.artifacts(tx, p, r);
    const script = artifacts.find((a) => a.artifactKey === `customized-script:${run.forkScriptId}`);
    if (!script || !isCustomizedStoryboardScript(script.payload))
      return customizedConflict('请先选择已保存的完整脚本');
    const state = await this.state(tx, p, r),
      catalog = artifacts.find((a) => a.artifactKey === 'customized-asset-catalog'),
      plan = artifacts.find((a) => a.artifactKey === 'customized-video-plan');
    const data = state?.state as unknown as
      { sourceRevision: number; document: ProductionDocument } | undefined;
    const legacyAssets = (script.payload.assets ?? []).map((a) => ({
      id: a.id,
      kind: ({ products: 'PRODUCT', characters: 'CHARACTER', scenes: 'SCENE' } as const)[a.kind],
      name: a.name,
      description: a.description,
      knownFacts: '',
      designNotes: '',
      sourceText: '旧脚本资产定义，使用前请核对',
    }));
    const legacyShots = script.payload.shots.map((s) => ({
      id: s.id,
      title: s.title,
      shotType: s.shotType,
      cameraMovement: s.cameraMovement,
      durationSeconds: s.durationSeconds,
      visual: s.visual,
      dialogue: s.dialogues.map((d) => `${d.speaker}：${d.text}`).join('\n'),
      audio: s.audio,
      atmosphere: s.continuity,
      bindings: Object.values(s.assetRequirements ?? {}).flatMap((g) => g.items),
    }));
    const confirmedDocument: ProductionDocument =
      isProductionDocument({
        ...(plan?.payload as object),
        assets:
          (catalog?.payload as unknown as { assets: ProductionDocument['assets'] })?.assets ??
          legacyAssets,
      }) && (plan?.payload as Record<string, unknown>)?.schemaVersion === 2
        ? {
            ...(plan!.payload as unknown as ProductionVideoDocument),
            assets:
              (catalog?.payload as unknown as { assets: ProductionDocument['assets'] })?.assets ??
              legacyAssets,
          }
        : {
            assets:
              (catalog?.payload as unknown as { assets: ProductionDocument['assets'] })?.assets ??
              legacyAssets,
            shots: (plan?.payload as unknown as { shots: ProductionShot[] })?.shots ?? legacyShots,
          };
    const document =
      data?.sourceRevision === script.revision && isProductionDocument(data.document)
        ? data.document
        : confirmedDocument;
    const creationTaskId = run.branchCreationKey?.startsWith('assets:')
      ? run.branchCreationKey.slice('assets:'.length)
      : null;
    const taskScope = {
      projectId: p,
      OR: [
        { workflowRunId: r },
        ...(creationTaskId ? [{ id: creationTaskId, operation: 'ASSETS' }] : []),
      ],
    };
    const tasks = await tx.customizedProductionTask.findMany({
      where: taskScope,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30,
    });
    // Image iteration must not hide the extraction behind the sole workflow entry.
    if (!tasks.some((t) => t.operation === 'ASSETS')) {
      const head = await tx.customizedProductionTask.findFirst({
        where: { ...taskScope, operation: 'ASSETS' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (head) tasks.push(head);
    }
    const brandMaterials = normalizeCustomizedImportDraft(
      artifacts.find((a) => a.artifactKey === 'customized-source-package')?.payload,
    ).materials.filter((m) => m.category === 'VISUAL_REFERENCE');
    const brandVersions = brandMaterials.length
      ? await tx.assetVersion.findMany({
          where: {
            projectId: p,
            OR: brandMaterials.map((m) => ({ assetId: m.assetId, version: m.assetVersion })),
            mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
            status: { not: 'UNAVAILABLE' },
            asset: {
              storageWorkflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
              archivedAt: null,
            },
          },
        })
      : [];
    return {
      brandImageReferences: brandVersions
        .filter((v) => v.storageKey && v.sizeBytes <= CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES)
        .map((v) => ({ assetId: v.assetId, version: v.version, name: v.originalFileName })),
      script: script.payload,
      source: { artifactId: script.id, revision: script.revision, fingerprint: script.contentHash },
      sourceReady: script.freshness === 'CURRENT',
      document,
      confirmedDocument,
      draftRevision: state?.revision ?? 0,
      assetsConfirmed: catalog?.freshness === 'CURRENT',
      shotsConfirmed: plan?.freshness === 'CURRENT',
      prompts: artifacts
        .filter(
          (a) =>
            a.artifactKey.startsWith('customized-shot-prompt:') ||
            a.artifactKey.startsWith('customized-clip-prompt:'),
        )
        .map((a) => ({
          value: a.payload as unknown as ProductionPromptValue,
          stale: a.freshness !== 'CURRENT',
          revision: a.revision,
        })),
      videos: artifacts
        .filter((a) => a.artifactKey.startsWith('customized-clip-video:'))
        .map((a) => ({
          value: a.payload as unknown as CustomizedVideoResult,
          revision: a.revision,
          stale: a.freshness !== 'CURRENT',
        })),
      videoSettings: (
        await tx.workflowNodeState.findMany({
          where: {
            projectId: p,
            workflowRunId: r,
            nodeId: { startsWith: 'CUSTOMIZED_VIDEO_RENDER_SETTINGS:' },
          },
        })
      ).flatMap((s) => {
        const value = s.state as { clipId?: string; settings?: unknown };
        return typeof value.clipId === 'string' && isCustomizedVideoRenderSettings(value.settings)
          ? [{ clipId: value.clipId, revision: s.revision, settings: value.settings }]
          : [];
      }),
      tasks: tasks.map(presentProductionTask),
    };
  }
  workspace(p: string, r: string) {
    return this.db.$transaction((tx) => this.read(tx, p, r), { timeout: 15000 });
  }
  saveVideoSettings(
    p: string,
    r: string,
    clipId: string,
    revision: number,
    settings: CustomizedVideoRenderSettings,
  ) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const w = await this.read(tx, p, r);
      if (
        !isCustomizedVideoRenderSettings(settings) ||
        !isVideoDocument(w.document) ||
        !w.document.videoPlan.clips.some((c) => c.id === clipId)
      )
        invalid('渲染设置或当前分镜无效');
      const nodeId = renderSettingsNode(clipId);
      const old = await tx.workflowNodeState.findUnique({
        where: { projectId_workflowRunId_nodeId: { projectId: p, workflowRunId: r, nodeId } },
      });
      if ((old?.revision ?? 0) !== revision)
        return customizedConflict('渲染设置已变化，请重新加载');
      const hash = workflowStateHash(settings);
      if (old?.contentHash === hash) return { clipId, revision: old.revision, settings };
      const state = await tx.workflowNodeState.upsert({
        where: { projectId_workflowRunId_nodeId: { projectId: p, workflowRunId: r, nodeId } },
        create: {
          projectId: p,
          workflowRunId: r,
          nodeId,
          state: json({ clipId, settings }),
          contentHash: hash,
          revision: 1,
        },
        update: {
          state: json({ clipId, settings }),
          contentHash: hash,
          revision: { increment: 1 },
        },
      });
      return { clipId, revision: state.revision, settings };
    });
  }
  latestPromptTask(p: string, r: string, clipId: string): Promise<ProductionTask | null> {
    return this.db.$transaction(async (tx) => {
      await this.scope(tx, p, r);
      const artifacts = await this.artifacts(tx, p, r);
      const document = artifacts.find((a) => a.artifactKey === 'customized-video-plan')?.payload;
      if (
        !isProductionDocument(document) ||
        !isVideoDocument(document) ||
        !document.videoPlan.clips.some((c) => c.id === clipId)
      )
        return null;
      const task = await tx.customizedProductionTask.findFirst({
        where: {
          projectId: p,
          workflowRunId: r,
          operation: 'PROMPT',
          inputSnapshot: { path: ['target', 'id'], equals: clipId },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return task ? presentProductionTask(task) : null;
    });
  }
  private async writeDraft(
    tx: Tx,
    p: string,
    r: string,
    document: ProductionDocument,
    sourceRevision: number,
    expected: number,
  ) {
    const old = await this.state(tx, p, r);
    if ((old?.revision ?? 0) !== expected)
      return customizedConflict('内容已经更新，本地修改已保留，请重新加载后核对');
    const contentHash = workflowStateHash({ document, sourceRevision });
    if (old?.contentHash === contentHash) return old;
    return tx.workflowNodeState.upsert({
      where: {
        projectId_workflowRunId_nodeId: {
          projectId: p,
          workflowRunId: r,
          nodeId: 'CUSTOMIZED_PRODUCTION_DRAFT',
        },
      },
      create: {
        projectId: p,
        workflowRunId: r,
        nodeId: 'CUSTOMIZED_PRODUCTION_DRAFT',
        state: json({ document, sourceRevision }),
        contentHash,
        revision: 1,
      },
      update: {
        state: json({ document, sourceRevision }),
        contentHash,
        revision: { increment: 1 },
      },
    });
  }
  private dependency(a: WorkingArtifact) {
    return {
      sourceType: 'WORKING_ARTIFACT' as const,
      sourceArtifactId: a.id,
      sourceNodeId: a.nodeId,
      sourceKey: a.artifactKey,
      sourceRevision: a.revision,
      sourceHash: a.contentHash,
    };
  }
  private async commit(
    tx: Tx,
    p: string,
    r: string,
    node: string,
    key: string,
    name: string,
    payload: unknown,
    sources: WorkingArtifact[],
  ) {
    return this.working.commitValidatedArtifactsInTransaction(tx, p, r, node, [
      {
        artifactKey: key,
        input: {
          kind: 'STRUCTURED',
          name: name.slice(0, 120),
          directory: 'SCRIPTS',
          type: 'STORYBOARD_SCRIPT',
          payload,
          dependencies: sources.map((a) => this.dependency(a)),
        },
      },
    ]);
  }
  private async commitAssets(tx: Tx, p: string, r: string, value: ProductionDocument) {
    const artifacts = await this.artifacts(tx, p, r);
    const run = await this.scope(tx, p, r);
    const story = artifacts.find((a) => a.artifactKey === `customized-script:${run.forkScriptId}`)!;
    const brief = artifacts.find((a) => a.artifactKey === 'customized-brief');
    const dependencies = brief ? [story, brief] : [story];
    if (!value.assets.some((a) => a.kind === 'PRODUCT')) invalid('请保留独立的产品资产定义');
    for (const a of value.assets)
      await this.commit(
        tx,
        p,
        r,
        'SHOT_PROMPT',
        `customized-object:${a.id}`,
        a.name,
        a,
        dependencies,
      );
    // Removed objects invalidate only their actual dependent shots/prompts.
    for (const a of artifacts.filter(
      (a) =>
        a.artifactKey.startsWith('customized-object:') &&
        !value.assets.some((v) => `customized-object:${v.id}` === a.artifactKey),
    ))
      await this.commit(tx, p, r, 'SHOT_PROMPT', a.artifactKey, a.name, { removed: true }, [story]);
    await this.commit(
      tx,
      p,
      r,
      'SHOT_PROMPT',
      'customized-asset-catalog',
      '资产目录',
      { assets: value.assets },
      dependencies,
    );
  }
  async save(
    p: string,
    r: string,
    revision: number,
    document: ProductionDocument,
    section: 'ASSETS' | 'SHOTS',
    confirm: boolean,
  ) {
    if (!isProductionDocument(document)) invalid('资产或镜头结构不完整，请检查名称、时长和绑定');
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const w = await this.read(tx, p, r);
        if (!w.sourceReady) return customizedConflict('故事已经变化，请先确认当前脚本');
        if (
          await tx.customizedProductionTask.count({
            where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
          })
        )
          return customizedConflict('当前制作任务执行中，请等待或取消后再编辑');
        // Each editor owns its section only, never overwrite the other node's data.
        const value = mergeVideoSection(
          w.document,
          section === 'ASSETS'
            ? withProductionAssets(document, recordAssetEdits(w.document.assets, document.assets))
            : document,
          section,
        );
        if (!isProductionDocument(value)) invalid('镜头引用的资产已发生变化');
        if (section === 'SHOTS' && isVideoDocument(value)) {
          const current = await this.artifacts(tx, p, r);
          if (
            videoHash(value.videoPlan.sourceUnits) !==
            videoHash(buildVideoSourceUnits(w.script.story?.content ?? w.script.synopsis))
          )
            return customizedConflict('分镜来源正文已变化');
          const required = [
            w.source.artifactId,
            ...current
              .filter((a) =>
                ['customized-brief', 'customized-asset-catalog'].includes(a.artifactKey),
              )
              .map((a) => a.id),
          ];
          if (
            required.some((id) => !value.videoPlan.sources.some((s) => s.id === id)) ||
            value.videoPlan.sources.some(
              (s) =>
                !current.some(
                  (a) =>
                    a.id === s.id &&
                    a.revision === s.revision &&
                    a.contentHash === s.hash &&
                    a.freshness === 'CURRENT',
                ),
            )
          )
            return customizedConflict('分镜制作依据已变化，请重新生成');
        }
        // Uploaded visual references must belong to this project and exact version.
        for (const a of value.assets)
          if (a.image) {
            const exists = await tx.assetVersion.findFirst({
              where: {
                projectId: p,
                assetId: a.image.assetId,
                version: a.image.version,
                mimeType: { startsWith: 'image/' },
                asset: {
                  projectId: p,
                  storageWorkflow: 'CUSTOMIZED',
                  workflowSpace: 'CUSTOMIZED_PROJECT',
                },
              },
            });
            if (!exists) invalid('图片版本不存在或不属于当前项目');
          }
        let state = await this.writeDraft(tx, p, r, value, w.source.revision, revision);
        if (confirm) {
          const artifacts = await this.artifacts(tx, p, r),
            story = artifacts.find((a) => a.id === w.source.artifactId)!;
          if (section === 'ASSETS') {
            await this.commitAssets(tx, p, r, value);
            const rebased = await applyImageOnlyPlanRebase(tx, this.working, p, r, value);
            if (rebased)
              state = await this.writeDraft(tx, p, r, rebased, w.source.revision, state.revision);
          } else {
            if (
              !w.assetsConfirmed ||
              !productionShots(value).length ||
              productionShots(value).some((s) => !s.visual.trim())
            )
              invalid('请确认资产目录并补齐分镜画面');
            const objects = await this.artifacts(tx, p, r);
            const catalog = objects.find((a) => a.artifactKey === 'customized-asset-catalog');
            if (
              !catalog ||
              workflowStateHash(catalog.payload) !== workflowStateHash({ assets: value.assets })
            )
              return customizedConflict('资产目录有未确认修改，请先保存资产准备');
            const savedShots = isVideoDocument(value) ? value.videoPlan.shots : value.shots;
            const brief = objects.find((a) => a.artifactKey === 'customized-brief');
            if (isVideoDocument(value) && (!brief || brief.freshness !== 'CURRENT'))
              return customizedConflict('信息卡已变化，请重新确认制作依据');
            for (const s of savedShots)
              await this.commit(
                tx,
                p,
                r,
                'SHOT_RENDER',
                `customized-shot:${s.id}`,
                s.title || '镜头',
                s,
                [
                  story,
                  ...(isVideoDocument(value) && brief ? [brief] : []),
                  ...s.bindings
                    .map((b) =>
                      objects.find((a) => a.artifactKey === `customized-object:${b.assetId}`)!,
                    )
                    .filter(Boolean),
                ],
              );
            for (const a of artifacts.filter(
              (a) =>
                a.artifactKey.startsWith('customized-shot:') &&
                !savedShots.some((s) => `customized-shot:${s.id}` === a.artifactKey),
            ))
              await this.commit(tx, p, r, 'SHOT_RENDER', a.artifactKey, a.name, { removed: true }, [
                story,
              ]);
            if (isVideoDocument(value)) {
              const current = await this.artifacts(tx, p, r);
              for (const clip of value.videoPlan.clips)
                await this.commit(
                  tx,
                  p,
                  r,
                  'SHOT_RENDER',
                  `customized-video-clip:${clip.id}`,
                  clip.title,
                  clipPayload(value, clip.id),
                  [
                    story,
                    ...(brief ? [brief] : []),
                    ...clip.shotIds
                      .map((id) => current.find((a) => a.artifactKey === `customized-shot:${id}`)!)
                      .filter(Boolean),
                    ...videoClipAssetIds(value.videoPlan, clip)
                      .map((id) =>
                        current.find((a) => a.artifactKey === `customized-object:${id}`)!,
                      )
                      .filter(Boolean),
                  ],
                );
              for (const a of artifacts.filter(
                (a) =>
                  a.artifactKey.startsWith('customized-video-clip:') &&
                  !value.videoPlan.clips.some(
                    (c) => a.artifactKey === `customized-video-clip:${c.id}`,
                  ),
              ))
                await this.commit(
                  tx,
                  p,
                  r,
                  'SHOT_RENDER',
                  a.artifactKey,
                  a.name,
                  { removed: true },
                  [story],
                );
            }
            await this.commit(
              tx,
              p,
              r,
              'SHOT_RENDER',
              'customized-video-plan',
              '分镜制作',
              isVideoDocument(value) ? value : { shots: value.shots },
              [story],
            );
          }
        }
        return { revision: state.revision };
      },
      { timeout: 30000 },
    );
  }
  private enqueue(tx: Tx, t: CustomizedProductionTask, delay = 0) {
    return tx.jobOutbox.upsert({
      where: {
        projectId_jobType_aggregateId: {
          projectId: t.projectId,
          jobType: 'CUSTOMIZED_PRODUCTION',
          aggregateId: t.id,
        },
      },
      create: {
        projectId: t.projectId,
        jobType: 'CUSTOMIZED_PRODUCTION',
        aggregateId: t.id,
        routingKey: productionQueue(t.operation),
        payload: { schemaVersion: 1, projectId: t.projectId, runId: t.id, requestId: randomUUID() },
        nextAttemptAt: new Date(Date.now() + delay),
      },
      update: {
        routingKey: productionQueue(t.operation),
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: new Date(Date.now() + delay),
        publishedAt: null,
      },
    });
  }
  savePrompt(p: string, r: string, revision: number, prompt: ProductionPromptValue) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const w = await this.read(tx, p, r),
          shot = productionShots(w.document).find(
            (s) => 'shotId' in prompt && s.id === prompt.shotId,
          );
        if ('target' in prompt) {
          if (!isVideoDocument(w.document) || !isProductionClipPrompt(prompt, w.document.videoPlan))
            return invalid('提示词与当前片段绑定不匹配');
          const referenceIssue = validateClipPromptReferences(prompt, w.document);
          if (referenceIssue) return invalid(referenceIssue);
          const artifacts = await this.artifacts(tx, p, r),
            source = artifacts.find(
              (a) => a.artifactKey === `customized-video-clip:${prompt.target.id}`,
            ),
            old = artifacts.find(
              (a) => a.artifactKey === `customized-clip-prompt:${prompt.target.id}`,
            );
          if (
            !w.sourceReady ||
            !source ||
            source.freshness !== 'CURRENT' ||
            workflowStateHash(source.payload) !==
              workflowStateHash(clipPayload(w.document, prompt.target.id))
          )
            return customizedConflict('请先保存当前片段及绑定');
          if ((old?.revision ?? 0) !== revision)
            return customizedConflict('提示词已更新，本地文字保留，请重新加载后核对');
          if (
            await tx.customizedProductionTask.count({
              where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
            })
          )
            return customizedConflict('制作任务执行中，请稍后保存');
          await this.commit(
            tx,
            p,
            r,
            'SHOT_RENDER',
            `customized-clip-prompt:${prompt.target.id}`,
            '片段提示词',
            prompt,
            [source],
          );
          return { accepted: true };
        }
        if (!shot || !isProductionPrompt(prompt, shot)) invalid('提示词与当前镜头绑定不匹配');
        const artifacts = await this.artifacts(tx, p, r),
          source = artifacts.find((a) => a.artifactKey === `customized-shot:${prompt.shotId}`),
          old = artifacts.find((a) => a.artifactKey === `customized-shot-prompt:${prompt.shotId}`);
        if (
          !w.sourceReady ||
          !source ||
          source.freshness !== 'CURRENT' ||
          workflowStateHash(source.payload) !== workflowStateHash(shot)
        )
          return customizedConflict('请先保存当前镜头及绑定');
        if ((old?.revision ?? 0) !== revision)
          return customizedConflict('提示词已更新，本地文字保留，请重新加载后核对');
        if (
          await tx.customizedProductionTask.count({
            where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
          })
        )
          return customizedConflict('制作任务执行中，请等待或取消后再保存');
        await this.commit(
          tx,
          p,
          r,
          'SHOT_RENDER',
          `customized-shot-prompt:${prompt.shotId}`,
          `镜头提示词 · ${shot!.title}`,
          prompt,
          [
            source,
            ...shot!.bindings
              .map((b) =>
                artifacts.find((a) => a.artifactKey === `customized-object:${b.assetId}`)!,
              )
              .filter(Boolean),
          ],
        );
        return { accepted: true };
      },
      { timeout: 15000 },
    );
  }
  start(
    p: string,
    r: string,
    revision: number,
    operation: ProductionOperation,
    key: string,
    shotId: string | null,
    models: Snapshot['models'],
    targetAssetId: string | null = null,
    imageSettings?: CustomizedImageSettings,
    videoSettings?: {
      version?: 2;
      durationPolicy?: VideoDurationPolicy;
      target?: { kind: 'CLIP'; id: string };
      render?: { settings: CustomizedVideoRenderSettings; model: string };
    },
  ) {
    if (
      videoSettings?.durationPolicy !== undefined &&
      !isVideoDurationPolicy(videoSettings.durationPolicy)
    )
      invalid('请选择有效的制作时长');
    if (
      videoSettings?.target &&
      (!['PROMPT', 'RENDER'].includes(operation) ||
        videoSettings.target.kind !== 'CLIP' ||
        typeof videoSettings.target.id !== 'string' ||
        !videoSettings.target.id.trim() ||
        videoSettings.target.id.length > 200)
    )
      invalid('制作片段目标不正确');
    if (operation === 'IMAGE' && isCustomizedImageSettings(imageSettings) && imageSettings.inputs)
      imageSettings = {
        ...imageSettings,
        inputs: imageSettings.inputs.map((i) => ({
          ...i,
          references: i.references.map((reference) => ({
            ...reference,
            assetId: reference.assetId.toLowerCase(),
          })),
        })),
      };
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        let w = await this.read(tx, p, r);
        const previous = await tx.customizedProductionTask.findUnique({
          where: { projectId_idempotencyKey: { projectId: p, idempotencyKey: key } },
        });
        if (previous) {
          if (
            previous.workflowRunId !== r ||
            previous.operation !== operation ||
            previous.shotId !== shotId ||
            workflowStateHash(snapshot(previous).target ?? null) !==
              workflowStateHash(videoSettings?.target ?? null) ||
            workflowStateHash(snapshot(previous).videoRender?.settings ?? null) !==
              workflowStateHash(videoSettings?.render?.settings ?? null) ||
            workflowStateHash(snapshot(previous).imageSettings ?? null) !==
              workflowStateHash(imageSettings ?? null) ||
            (snapshot(previous).targetAssetId ?? null) !== targetAssetId
          )
            return customizedConflict('请求标识已用于其他操作');
          return presentProductionTask(previous);
        }
        if (revision !== w.draftRevision || !w.sourceReady)
          return customizedConflict('创作依据已变化，请重新加载');
        const active = await tx.customizedProductionTask.findFirst({
          where: { projectId: p, workflowRunId: r, status: { in: ['QUEUED', 'RUNNING'] } },
        });
        if (active) return customizedConflict('已有制作任务执行中，请等待完成');
        if (operation === 'PROMPT' || operation === 'RENDER') {
          const rebased = await applyImageOnlyPlanRebase(tx, this.working, p, r, w.document);
          if (rebased) {
            const state = await this.writeDraft(tx, p, r, rebased, w.source.revision, revision);
            revision = state.revision;
            w = { ...w, document: rebased, draftRevision: revision };
          }
        }
        const artifacts = await this.artifacts(tx, p, r);
        const source = [artifacts.find((a) => a.id === w.source.artifactId)!];
        if (
          targetAssetId &&
          (operation !== 'ASSETS' || !w.document.assets.some((a) => a.id === targetAssetId))
        )
          invalid('选定资产不存在');
        const brief = artifacts.find((a) => a.artifactKey === 'customized-brief');
        if (operation === 'ASSETS') {
          if (!brief || brief.freshness !== 'CURRENT')
            return customizedConflict('信息卡已变化，请先确认创作依据');
          source.push(brief);
        }
        if (operation !== 'ASSETS') {
          const catalog = artifacts.find(
            (a) => a.artifactKey === 'customized-asset-catalog' && a.freshness === 'CURRENT',
          );
          if (
            !catalog ||
            workflowStateHash(catalog.payload) !== workflowStateHash({ assets: w.document.assets })
          )
            return customizedConflict('请先保存并确认资产目录');
          source.push(catalog);
        }
        const render =
          operation === 'RENDER'
            ? await freezeVideoRender(
                tx,
                p,
                w,
                artifacts,
                videoSettings?.target?.id ?? '',
                videoSettings?.render?.settings as CustomizedVideoRenderSettings,
                videoSettings?.render?.model ?? '',
              )
            : undefined;
        if (render) source.push(...render.sources);
        if (operation === 'IMAGE') {
          if (
            !isCustomizedImageSettings(imageSettings) ||
            imageSettings.assetIds.some(
              (id) => !w.document.assets.some((a) => a.id === id && a.description.trim()),
            )
          )
            invalid('请选择有效的生图模型、尺寸和已填写公共形象的资产');
          const selectionIssue = customizedAssetImageSelectionIssue(
            w.document.assets,
            imageSettings!.assetIds,
          );
          if (selectionIssue) invalid(selectionIssue);
          if (!brief || brief.freshness !== 'CURRENT')
            return customizedConflict('品牌信息已变化，请先确认创作依据');
          source.push(brief);
          for (const reference of imageSettings!.inputs?.flatMap((i) => i.references) ?? []) {
            const file = await tx.assetVersion.findFirst({
              where: {
                projectId: p,
                assetId: reference.assetId,
                version: reference.version,
                status: { not: 'UNAVAILABLE' },
                mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
                asset: {
                  storageWorkflow: 'CUSTOMIZED',
                  workflowSpace: 'CUSTOMIZED_PROJECT',
                  archivedAt: null,
                },
              },
            });
            if (
              !file?.storageKey ||
              file.sizeBytes <= 0 ||
              file.sizeBytes > CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES
            )
              invalid('参考图片版本不可用，请移除后重新选择');
          }
        } else if (imageSettings) invalid('此任务不接受图片设置');
        const videoV2 =
          (operation === 'SHOTS' && videoSettings?.version === 2) ||
          (operation === 'PROMPT' && isVideoDocument(w.document));
        if (videoV2) {
          if (!brief || brief.freshness !== 'CURRENT')
            return customizedConflict('请先确认当前信息卡');
          source.push(brief);
        }
        if (operation === 'PROMPT' && videoV2) {
          if (shotId || videoSettings?.target?.kind !== 'CLIP' || !isVideoDocument(w.document))
            invalid('请选择当前视频片段');
          const targetId = videoSettings!.target!.id;
          const a = artifacts.find(
            (a) =>
              a.artifactKey === `customized-video-clip:${targetId}` && a.freshness === 'CURRENT',
          );
          if (
            !a ||
            workflowStateHash(a.payload) !==
              workflowStateHash(clipPayload(w.document as ProductionVideoDocument, targetId))
          )
            return customizedConflict('请先保存当前片段和分镜');
          source.push(a);
        } else if (operation === 'PROMPT') {
          if (videoSettings?.target) invalid('旧版镜头不接受片段目标');
          const shot = productionShots(w.document).find((s) => s.id === shotId),
            a = artifacts.find(
              (a) => a.artifactKey === `customized-shot:${shotId}` && a.freshness === 'CURRENT',
            );
          if (!shot || !a || workflowStateHash(a.payload) !== workflowStateHash(shot))
            return customizedConflict('请先保存当前镜头及资产绑定');
          source.push(a);
        }
        const input: Snapshot = {
          script: w.script,
          brief: artifacts.find((a) => a.artifactKey === 'customized-brief')?.payload,
          document: w.document,
          sources: source.map((a) => ({ id: a.id, revision: a.revision, hash: a.contentHash })),
          draftRevision: revision,
          models,
          operation,
          shotId,
          ...(videoV2
            ? {
                shotWorkflowVersion: 2 as const,
                ...(operation === 'SHOTS'
                  ? { shotBenefitPolicyVersion: 1 as const, shotDurationStepMs: 1000 as const }
                  : {}),
                ...(operation === 'PROMPT' ? { promptWorkflowVersion: 3 as const } : {}),
                strategyVersion: CUSTOMIZED_VIDEO_STRATEGY,
                requestLimits: { ...CUSTOMIZED_VIDEO_LIMITS },
                identitySeed: randomUUID(),
                durationPolicy:
                  operation === 'PROMPT' && isVideoDocument(w.document)
                    ? w.document.videoPlan.durationPolicy
                    : normalizeVideoPolicy(
                        videoSettings?.durationPolicy,
                        w.script.creation?.referenceDurationSeconds ?? 30,
                      ),
                sourceUnits: buildVideoSourceUnits(w.script.story?.content ?? w.script.synopsis),
                renderCapability:
                  operation === 'PROMPT' && isVideoDocument(w.document)
                    ? w.document.videoPlan.capability
                    : {
                        key: 'TEXT_PLAN',
                        status: 'PENDING_MODEL_CHECK' as const,
                        minClipMs: 4000,
                        maxClipMs: 15000,
                        version: 'configured-2026-10-19',
                      },
                ...(videoSettings?.target ? { target: videoSettings.target } : {}),
              }
            : {}),
          ...(imageSettings ? { imageSettings } : {}),
          ...(render
            ? {
                videoRender: render.input,
                target: { kind: 'CLIP' as const, id: render.input.clipId },
              }
            : {}),
          ...(operation === 'ASSETS'
            ? { assetWorkflowVersion: 2 as const, targetAssetId, identitySeed: randomUUID() }
            : {}),
        };
        const t = await tx.customizedProductionTask.create({
          data: {
            projectId: p,
            workflowRunId: r,
            operation,
            shotId,
            idempotencyKey: key,
            inputSnapshot: json(input),
            steps: json(
              productionStages(
                operation,
                input.assetWorkflowVersion,
                input.shotWorkflowVersion,
                input.promptWorkflowVersion,
              ).map((s) => ({
                id: s.id,
                status: 'PENDING',
                title: s.label,
                content: '',
              })),
            ),
          },
        });
        await this.enqueue(tx, t);
        return presentProductionTask(t);
      },
      { timeout: 15000 },
    );
  }
  private async valid(tx: Tx, t: CustomizedProductionTask) {
    await this.scope(tx, t.projectId, t.workflowRunId);
    const input = snapshot(t),
      artifacts = await this.artifacts(tx, t.projectId, t.workflowRunId);
    if (
      input.sources.some(
        (s) =>
          !artifacts.some(
            (a) =>
              a.id === s.id &&
              a.revision === s.revision &&
              a.contentHash === s.hash &&
              a.freshness === 'CURRENT',
          ),
      )
    )
      return customizedConflict('任务来源已变化，请基于当前内容重新生成');
    const state = await this.state(tx, t.projectId, t.workflowRunId);
    if (input.videoRender) {
      for (const reference of input.videoRender.references) {
        const version = await tx.assetVersion.findFirst({
          where: {
            projectId: t.projectId,
            assetId: reference.assetId,
            version: reference.version,
            storageKey: reference.storageKey,
            sizeBytes: reference.sizeBytes,
            status: { not: 'UNAVAILABLE' },
            asset: {
              archivedAt: null,
              storageWorkflow: 'CUSTOMIZED',
              workflowSpace: 'CUSTOMIZED_PROJECT',
            },
          },
        });
        if (!version) return customizedConflict('本镜引用图片版本已不可用');
      }
    }
    if (input.operation === 'IMAGE') {
      const current = (await this.read(tx, t.projectId, t.workflowRunId)).document;
      const withoutImages = (doc: ProductionDocument) => ({
        ...doc,
        assets: doc.assets.map((a) => ({ ...a, image: null })),
      });
      if (
        workflowStateHash(withoutImages(current)) !==
        workflowStateHash(withoutImages(input.document))
      )
        return customizedConflict('资产定义已变化，请重新生成图片');
      const images = (t.output ?? {}) as Record<string, unknown>;
      if (
        current.assets.some(
          (a) =>
            workflowStateHash(a.image ?? null) !==
            workflowStateHash(
              (Object.hasOwn(images, a.id) ? images[a.id] : undefined) ??
                input.document.assets.find((v) => v.id === a.id)?.image ??
                null,
            ),
        )
      )
        return customizedConflict('资产图片已被替换，请创建新的制作任务');
    } else if ((state?.revision ?? 0) !== input.draftRevision)
      return customizedConflict('制作草稿已改变，请重新生成');
  }
  private async task(tx: Tx, p: string, id: string) {
    const t = await tx.customizedProductionTask.findFirst({ where: { projectId: p, id } });
    if (!t) return missing();
    return t;
  }
  getTask(p: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const t = await this.task(tx, p, id);
      await this.scope(tx, p, t.workflowRunId);
      return presentProductionTask(t);
    });
  }
  candidate(p: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const t = await this.task(tx, p, id);
      await this.scope(tx, p, t.workflowRunId);
      const saved = t.output as Record<string, unknown> | null;
      const document = candidateForPreview(saved);
      if (!document) return missing();
      const original = candidateForPreview({ value: saved?.value });
      return {
        document,
        candidateHash: videoHash(document),
        adopted: !!saved?.manualDraftAdoptedRevision,
        validForDraft: !!candidateDocument(saved),
        ...(original && videoHash(original) !== videoHash(document)
          ? { originalDocument: original }
          : {}),
        issues: (((saved?.recheck ?? saved?.audit) as VideoAudit | undefined)?.findings ?? []).map(
          (issue) => ({
            ...issue,
            title: videoReadableText(document.videoPlan, document.assets, issue.title),
            impact: videoReadableText(document.videoPlan, document.assets, issue.impact),
            suggestedFix: videoReadableText(
              document.videoPlan,
              document.assets,
              issue.suggestedFix,
            ),
          }),
        ),
      } satisfies VideoCandidate;
    });
  }
  reviewDraft(p: string, id: string, expectedRevision: number, candidateHash?: string) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const t = await this.task(tx, p, id);
        const input = snapshot(t),
          saved = t.output as Record<string, unknown> | null;
        if (t.status === 'FAILED' && t.operation === 'SHOTS' && input.shotWorkflowVersion === 2) {
          const candidate = candidateDocument(saved);
          if (!candidate || saved?.manualDraftAdoptedRevision)
            return customizedConflict('没有可供核对的分镜草稿');
          if (!candidateHash || candidateHash !== videoHash(candidate))
            return customizedConflict('核对候选已经变化，请重新查看');
          await this.valid(tx, t);
          const issue = validateVideoSnapshot(candidate, input);
          if (issue) invalid(issue);
          if (
            await tx.customizedProductionTask.count({
              where: {
                projectId: p,
                workflowRunId: t.workflowRunId,
                status: { in: ['QUEUED', 'RUNNING'] },
              },
            })
          )
            return customizedConflict('已有制作任务执行中');
          const draft = await this.writeDraft(
            tx,
            p,
            t.workflowRunId,
            candidate,
            input.sources[0]!.revision,
            expectedRevision,
          );
          await tx.customizedProductionTask.update({
            where: { id },
            data: { output: json({ ...saved, manualDraftAdoptedRevision: draft.revision }) },
          });
          return { revision: draft.revision };
        }
        if (
          t.status !== 'FAILED' ||
          t.operation !== 'ASSETS' ||
          input.assetWorkflowVersion !== 2 ||
          !Array.isArray(saved?.revised) ||
          saved.manualDraftAdoptedRevision
        )
          return customizedConflict('没有可供人工核对的完整草稿');
        await this.valid(tx, t);
        const w = await this.read(tx, p, t.workflowRunId);
        if (
          await tx.customizedProductionTask.count({
            where: {
              projectId: p,
              workflowRunId: t.workflowRunId,
              status: { in: ['QUEUED', 'RUNNING'] },
            },
          })
        )
          return customizedConflict('已有制作任务执行中，请等待完成');
        if (w.draftRevision !== expectedRevision)
          return customizedConflict('草稿已改变，本地修改已保留');
        const value = { assets: saved.revised, shots: [] };
        if (!isProductionDocument(value)) invalid('人工核对草稿结构不完整');
        const document = value as ProductionDocument;
        if (!input.targetAssetId && !document.assets.some((a) => a.kind === 'PRODUCT'))
          invalid('资产草稿缺少产品定义');
        const issue = validatePreparedAssets(document, input);
        if (issue) invalid(issue);
        const inventory = saved.inventory as { id: string }[] | undefined;
        if (
          !Array.isArray(inventory) ||
          inventory.length !== document.assets.length ||
          new Set(inventory.map((a) => a.id)).size !== document.assets.length ||
          inventory.some((a) => !document.assets.some((v) => v.id === a.id)) ||
          !['PRODUCT', 'CHARACTER', 'SCENE', 'PROP', 'IMAGE_PLAN', 'REVIEW'].every((id) =>
            (t.steps as unknown as ProductionStep[]).some(
              (s) => s.id === id && s.status === 'SUCCEEDED',
            ),
          )
        )
          return customizedConflict('资产定义尚未完整生成，不能进入人工核对');
        const draft = await this.writeDraft(
          tx,
          p,
          t.workflowRunId,
          {
            ...withProductionAssets(
              input.document,
              mergePreparedAssets(input.document.assets, document.assets),
            ),
          },
          input.sources[0]!.revision,
          expectedRevision,
        );
        await tx.customizedProductionTask.update({
          where: { id },
          data: { output: json({ ...saved, manualDraftAdoptedRevision: draft.revision }) },
        });
        return { revision: draft.revision };
      },
      { timeout: 15000 },
    );
  }
  claim(p: string, id: string, node?: ProductionWorkerNode) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const t = await this.task(tx, p, id);
      assertWorkerOperation(t.operation, node);
      if (!['QUEUED', 'RUNNING'].includes(t.status)) return { terminal: true };
      if (t.status === 'RUNNING' && t.leaseExpiresAt && t.leaseExpiresAt > new Date())
        return { busy: true };
      try {
        await this.valid(tx, t);
      } catch (e) {
        if (!(e instanceof ApiHttpException)) throw e;
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            status: 'FAILED',
            errorMessage: '任务依据已变化，请重新生成',
            attemptToken: null,
            leaseExpiresAt: null,
          },
        });
        return { terminal: true };
      }
      const token = randomUUID();
      await tx.customizedProductionTask.update({
        where: { id },
        data: {
          status: 'RUNNING',
          attemptToken: token,
          attemptCount: { increment: 1 },
          leaseExpiresAt: new Date(Date.now() + 90000),
          errorMessage: null,
        },
      });
      return { attemptToken: token, input: t.inputSnapshot, output: t.output, steps: t.steps };
    });
  }
  rerouteLegacyAssets(p: string, id: string) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const t = await this.task(tx, p, id);
      if (t.operation !== 'ASSETS' || t.status !== 'QUEUED') return { forwarded: false };
      await this.enqueue(tx, t);
      return { forwarded: true };
    });
  }
  private async lease(tx: Tx, p: string, id: string, token: string, node?: ProductionWorkerNode) {
    await lockCustomizedProject(tx, p);
    const t = await this.task(tx, p, id);
    assertWorkerOperation(t.operation, node);
    if (
      t.status !== 'RUNNING' ||
      !token ||
      t.attemptToken !== token ||
      !t.leaseExpiresAt ||
      t.leaseExpiresAt <= new Date()
    )
      return customizedConflict('执行已取消或租约失效');
    await this.valid(tx, t);
    return t;
  }
  heartbeat(p: string, id: string, token: string, node?: ProductionWorkerNode) {
    return this.db.$transaction(async (tx) => {
      await this.lease(tx, p, id, token, node);
      await tx.customizedProductionTask.update({
        where: { id },
        data: { leaseExpiresAt: new Date(Date.now() + 90000) },
      });
      return { accepted: true };
    });
  }
  videoRenderScope(p: string, id: string, token: string, allowCompleted = false) {
    return this.db.$transaction(async (tx) => {
      const row = await this.task(tx, p, id);
      if (row.operation !== 'RENDER') invalid('不是视频渲染任务');
      const t =
        allowCompleted && row.status === 'COMPLETED' && row.attemptToken === token
          ? row
          : await this.lease(tx, p, id, token, 'VIDEO');
      const project = await tx.project.findUniqueOrThrow({ where: { id: p } });
      if (project.deletionState) return customizedConflict('项目正在删除');
      return {
        input: snapshot(t).videoRender!,
        projectName: project.name,
        result:
          t.status === 'COMPLETED'
            ? (t.output as { video?: CustomizedVideoResult })?.video
            : undefined,
      };
    });
  }
  async videoFile(p: string, r: string, clipId: string, poster = false) {
    return this.db.$transaction(async (tx) => {
      await this.scope(tx, p, r);
      const artifact = await tx.workingArtifact.findFirst({
        where: {
          projectId: p,
          workflowRunId: r,
          artifactKey: `customized-clip-video:${clipId}`,
          availability: 'AVAILABLE',
        },
      });
      const result = artifact?.payload as unknown as CustomizedVideoResult | undefined;
      if (!result) return missing();
      const file = await tx.fileObject.findFirst({
        where: {
          projectId: p,
          id: poster ? result.posterFileObjectId : result.fileObjectId,
          status: 'AVAILABLE',
          artifactLinks: { some: { workingArtifactId: artifact!.id } },
        },
      });
      if (!file) return missing();
      return file;
    });
  }
  acceptVideo(
    p: string,
    id: string,
    token: string,
    info: CustomizedVideoFileInfo,
    files: {
      video: { storageKey: string; sizeBytes: number; sha256: string };
      poster: { storageKey: string; sizeBytes: number; sha256: string };
    },
  ) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const row = await this.task(tx, p, id);
        if (row.operation !== 'RENDER') invalid('不是视频渲染任务');
        if (row.status === 'COMPLETED' && row.attemptToken === token)
          return { stored: false, video: (row.output as { video: CustomizedVideoResult }).video };
        const t = await this.lease(tx, p, id, token, 'VIDEO');
        const input = snapshot(t),
          render = input.videoRender!;
        const issue = videoFileIssues(render.settings, render.seconds, info);
        if (issue) invalid(issue);
        if (!(t.output as { providerTaskId?: string } | null)?.providerTaskId)
          invalid('缺少已保存的供应商任务');
        const existing = await tx.workingArtifact.findFirst({
          where: {
            projectId: p,
            workflowRunId: t.workflowRunId,
            artifactKey: `customized-clip-video:${render.clipId}`,
            availability: 'AVAILABLE',
            freshness: 'CURRENT',
          },
          include: { files: { include: { fileObject: true } }, dependencies: true },
        });
        const oldVideo = existing?.payload as unknown as CustomizedVideoResult | undefined;
        const identical =
          !!oldVideo &&
          workflowStateHash(oldVideo.settings) === workflowStateHash(render.settings) &&
          oldVideo.durationSeconds === info.durationSeconds &&
          oldVideo.width === info.width &&
          oldVideo.height === info.height &&
          existing!.files.some(
            (f) => f.role === 'PRIMARY' && f.fileObject.sha256 === files.video.sha256,
          ) &&
          existing!.files.some(
            (f) => f.role === 'POSTER' && f.fileObject.sha256 === files.poster.sha256,
          ) &&
          existing!.dependencies.length === input.sources.length &&
          input.sources.every((s) =>
            existing!.dependencies.some(
              (d) =>
                d.sourceArtifactId === s.id &&
                d.sourceRevision === s.revision &&
                d.sourceHash === s.hash,
            ),
          );
        if (identical) {
          await tx.customizedProductionTask.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              leaseExpiresAt: null,
              output: json({ ...((t.output as object) ?? {}), video: oldVideo }),
              steps: json(
                (t.steps as unknown as ProductionStep[]).map((s) => ({
                  ...s,
                  status: 'SUCCEEDED',
                  ...(s.id === 'SAVE'
                    ? { content: '视频内容与现有版本一致，已复用文件，不增加版本' }
                    : {}),
                })),
              ),
            },
          });
          return { stored: false, video: oldVideo! };
        }
        const records = await Promise.all(
          (['video', 'poster'] as const).map((kind) =>
            this.working.upsertFileObjectInTransaction(tx, p, t.workflowRunId, {
              ...files[kind],
              nodeId: 'SHOT_RENDER',
              originalFileName: `${render.clipId}${kind === 'poster' ? '-poster.jpg' : '.mp4'}`,
              mimeType: kind === 'poster' ? 'image/jpeg' : 'video/mp4',
            }),
          ),
        );
        const video: CustomizedVideoResult = {
          ...info,
          clipId: render.clipId,
          taskId: id,
          settings: render.settings,
          fileObjectId: records[0]!.id,
          posterFileObjectId: records[1]!.id,
        };
        const sources = (await this.artifacts(tx, p, t.workflowRunId)).filter((a) =>
          input.sources.some((s) => s.id === a.id),
        );
        await this.working.commitValidatedArtifactsInTransaction(
          tx,
          p,
          t.workflowRunId,
          'SHOT_RENDER',
          [
            {
              artifactKey: `customized-clip-video:${render.clipId}`,
              input: {
                kind: 'FILE',
                name: `${render.title} · 分镜视频`.slice(0, 120),
                directory: 'VIDEO_MATERIALS',
                type: 'VIDEO_MATERIAL',
                payload: video,
                storageKey: records[0]!.storageKey,
                mimeType: 'video/mp4',
                sizeBytes: records[0]!.sizeBytes,
                originalFileName: records[0]!.originalFileName,
                fileChecksum: records[0]!.sha256,
                files: records.map((f, i) => ({
                  fileObjectId: f.id,
                  role: i === 0 ? 'PRIMARY' : 'POSTER',
                  sortOrder: i,
                  originalFileName: f.originalFileName,
                  mimeType: f.mimeType,
                  sha256: f.sha256,
                })),
                dependencies: sources.map((a) => this.dependency(a)),
              },
            },
          ],
        );
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            leaseExpiresAt: null,
            output: json({ ...((t.output as object) ?? {}), video }),
            steps: json(
              (t.steps as unknown as ProductionStep[]).map((s) => ({
                ...s,
                status: 'SUCCEEDED',
                ...(s.id === 'REVIEW'
                  ? {
                      content: `视频已校验：${info.width}×${info.height}，${info.durationSeconds.toFixed(2)}秒`,
                    }
                  : s.id === 'SAVE'
                    ? { content: `${render.title}的视频已原位保存，可播放和下载` }
                    : {}),
              })),
            ),
          },
        });
        return { stored: true, video };
      },
      { timeout: 30000 },
    );
  }
  imageScope(p: string, id: string, token: string, objectId: string) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, 'ASSETS');
      const input = snapshot(t);
      if (t.operation !== 'IMAGE' || !input.imageSettings?.assetIds.includes(objectId))
        invalid('图片不属于本次选定资产');
      const asset = input.document.assets.find((a) => a.id === objectId)!;
      const project = await tx.project.findUniqueOrThrow({ where: { id: p } });
      return { name: asset.name, projectName: project.name };
    });
  }
  imageReferenceScope(p: string, id: string, token: string, assetId: string, version: number) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, 'ASSETS');
      if (
        t.operation !== 'IMAGE' ||
        !snapshot(t).imageSettings?.inputs?.some((i) =>
          i.references.some((r) => r.assetId === assetId && r.version === version),
        )
      )
        invalid('参考图片不属于本次任务');
      const file = await tx.assetVersion.findFirst({
        where: {
          projectId: p,
          assetId,
          version,
          status: { not: 'UNAVAILABLE' },
          mimeType: { in: ['image/png', 'image/jpeg', 'image/webp'] },
          asset: { storageWorkflow: 'CUSTOMIZED', workflowSpace: 'CUSTOMIZED_PROJECT' },
        },
      });
      if (!file?.storageKey || file.sizeBytes > CUSTOMIZED_IMAGE_REFERENCE_MAX_BYTES)
        return missing();
      return { storageKey: file.storageKey, mimeType: file.mimeType, sizeBytes: file.sizeBytes };
    });
  }
  acceptImage(
    p: string,
    id: string,
    token: string,
    objectId: string,
    file: {
      storageKey: string;
      sizeBytes: number;
      mimeType: string;
      originalFileName: string;
      sha256: string;
    },
  ) {
    return this.db.$transaction(
      async (tx) => {
        const t = await this.lease(tx, p, id, token, 'ASSETS');
        const input = snapshot(t);
        if (t.operation !== 'IMAGE' || !input.imageSettings?.assetIds.includes(objectId))
          invalid('图片不属于本次选定资产');
        const images = Object.assign(
          Object.create(null) as Record<string, { assetId: string; version: number }>,
          t.output ?? {},
        );
        if (images[objectId]) return { image: images[objectId], stored: false };
        const definition = input.document.assets.find((a) => a.id === objectId)!;
        const { sha256, ...metadata } = file;
        const record = await new AssetRepository(this.db).createInTransaction(
          tx,
          p,
          {
            ...metadata,
            name: definition.name.slice(0, 120),
            directory: 'VISUAL_ASSETS',
            type: (
              {
                PRODUCT: 'PRODUCT_ASSET',
                CHARACTER: 'PERSON_ASSET',
                SCENE: 'SCENE_BACKGROUND',
                PROP: 'VISUAL_ASSET',
              } as const
            )[definition.kind],
            storageWorkflow: 'CUSTOMIZED',
            workflowSpace: 'CUSTOMIZED_PROJECT',
            status: 'PENDING_REVIEW',
            qualityStatus: 'PENDING_REVIEW',
            tags: [],
            notes: 'AI 生成公共形象，使用前请核对',
            sourceRunId: t.workflowRunId,
            sourceNode: 'SHOT_PROMPT',
            sourceArtifactId: `customized-object:${objectId}`,
            idempotencyKey: `customized-image:${id}:${objectId}`,
            businessData: json({ objectId, taskId: id, model: input.imageSettings!.model }),
            workflowFile: { workflowRunId: t.workflowRunId, nodeId: 'SHOT_PROMPT', sha256 },
          },
          '资产图片生成',
        );
        const image = { assetId: record.id, version: record.currentVersion };
        images[objectId] = image;
        const w = await this.read(tx, p, t.workflowRunId);
        await this.writeDraft(
          tx,
          p,
          t.workflowRunId,
          {
            ...w.document,
            assets: w.document.assets.map((a) => (a.id === objectId ? { ...a, image } : a)),
          },
          w.source.revision,
          w.draftRevision,
        );
        const finished = input.imageSettings!.assetIds.every((assetId) => images[assetId]);
        const content = input
          .imageSettings!.assetIds.map((assetId) => {
            const name = input.document.assets.find((a) => a.id === assetId)!.name;
            return `${name}：${images[assetId] ? '图片已保存并关联' : '等待生成'}`;
          })
          .join('\n');
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            output: json(images),
            steps: json(
              (t.steps as unknown as ProductionStep[]).map((s) =>
                s.id === 'GENERATE'
                  ? { ...s, status: finished ? 'SUCCEEDED' : 'RUNNING', content }
                  : s,
              ),
            ),
          },
        });
        return { image, stored: true };
      },
      { timeout: 30000 },
    );
  }
  checkpoint(
    p: string,
    id: string,
    token: string,
    step: ProductionStep,
    output?: unknown,
    node?: ProductionWorkerNode,
  ) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, node);
      if (
        !(t.steps as unknown as ProductionStep[]).some((s) => s.id === step.id) ||
        step.id === 'SAVE' ||
        !['RUNNING', 'SUCCEEDED', 'FAILED'].includes(step.status)
      )
        invalid('执行步骤不正确');
      if (JSON.stringify(output ?? null).length > 2_000_000 || step.content.length > 100000)
        invalid('结果超过大小限制');
      if (t.operation === 'PROMPT' && output !== undefined) {
        const prior = (t.output ?? {}) as Record<string, unknown>;
        const next =
          output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
        if (
          workflowStateHash(prior.mechanicalRecovery ?? null) !==
          workflowStateHash(next.mechanicalRecovery ?? null)
        )
          return customizedConflict('机械恢复轮次不匹配，已有检查点保留');
      }
      if (t.operation === 'IMAGE' && (output !== undefined || step.id === 'GENERATE'))
        invalid('图片完成状态只能由已保存的文件更新');
      if (t.operation === 'RENDER' && output !== undefined) {
        const value = output as {
          providerTaskId?: unknown;
          createStarted?: unknown;
          rateLimited?: unknown;
          createRejected?: unknown;
        };
        const saved = (t.output ?? {}) as { providerTaskId?: string; createStarted?: boolean };
        if (
          !value ||
          typeof value !== 'object' ||
          Object.keys(value).some(
            (k) =>
              !['providerTaskId', 'createStarted', 'rateLimited', 'createRejected'].includes(k),
          ) ||
          (value.providerTaskId !== undefined &&
            (typeof value.providerTaskId !== 'string' ||
              !value.providerTaskId.trim() ||
              value.providerTaskId.length > 255)) ||
          (value.createStarted !== undefined && typeof value.createStarted !== 'boolean') ||
          (value.rateLimited !== undefined && typeof value.rateLimited !== 'boolean') ||
          (value.createRejected !== undefined && typeof value.createRejected !== 'boolean')
        )
          invalid('渲染检查点无效');
        if (
          saved.providerTaskId &&
          value.providerTaskId &&
          saved.providerTaskId !== value.providerTaskId
        )
          return customizedConflict('已提交的供应商任务不可替换');
        if (
          saved.createStarted &&
          value.createStarted === false &&
          value.rateLimited !== true &&
          value.createRejected !== true
        )
          invalid('不可清除已提交请求的保护状态');
        output = { ...saved, ...value };
      }
      const steps = t.steps as unknown as ProductionStep[];
      const old = steps.find((s) => s.id === step.id)!;
      if (old.status === 'SUCCEEDED') return { accepted: true };
      await tx.customizedProductionTask.update({
        where: { id },
        data: {
          steps: json(steps.map((s) => (s.id === step.id ? step : s))),
          ...(output === undefined ? {} : { output: json(output) }),
        },
      });
      return { accepted: true };
    });
  }
  complete(p: string, id: string, token: string, output: unknown, node?: ProductionWorkerNode) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const prior = await this.task(tx, p, id);
        assertWorkerOperation(prior.operation, node);
        if (prior.status === 'COMPLETED' && prior.attemptToken === token) return { accepted: true };
        const t = await this.lease(tx, p, id, token, node),
          input = snapshot(t),
          steps = t.steps as unknown as ProductionStep[];
        if (t.operation === 'RENDER') invalid('视频只能通过受保护的文件上传自动完成');
        if (t.operation === 'IMAGE') {
          const results = (t.output ?? {}) as Record<string, { assetId: string; version: number }>;
          if (
            !input.imageSettings?.assetIds.every((id) => Object.hasOwn(results, id)) ||
            !steps.filter((s) => s.id !== 'SAVE').every((s) => s.status === 'SUCCEEDED')
          )
            return customizedConflict('仍有资产图片未生成');
          await tx.customizedProductionTask.update({
            where: { id },
            data: {
              status: 'COMPLETED',
              leaseExpiresAt: null,
              steps: json(
                steps.map((s) =>
                  s.id === 'SAVE'
                    ? {
                        ...s,
                        status: 'SUCCEEDED',
                        content: '图片已关联到对应资产，保存修改后确认用于后续制作',
                      }
                    : s,
                ),
              ),
            },
          });
          return { accepted: true };
        }
        if (
          !steps.filter((s) => s.id !== 'SAVE').every((s) => s.status === 'SUCCEEDED') ||
          workflowStateHash(output) !==
            workflowStateHash((t.output as Record<string, unknown> | null)?.final ?? t.output)
        )
          return customizedConflict('内容尚未完成审校');
        if (input.operation === 'PROMPT') {
          if (input.shotWorkflowVersion === 2) {
            const issue = validateFinalClipPrompt(
              output,
              input,
              (t.output ?? {}) as Record<string, unknown>,
            );
            if (issue) invalid(issue);
            if (
              !isVideoDocument(input.document) ||
              !isProductionClipPrompt(output, input.document.videoPlan) ||
              output.target.id !== input.target?.id
            )
              invalid('片段提示词引用不匹配');
            const prompt = output as ProductionClipPrompt;
            const artifacts = await this.artifacts(tx, p, t.workflowRunId),
              source = artifacts.find(
                (a) => a.artifactKey === `customized-video-clip:${prompt.target.id}`,
              )!;
            if (!source) return customizedConflict('片段工作副本不存在');
            await this.commit(
              tx,
              p,
              t.workflowRunId,
              'SHOT_RENDER',
              `customized-clip-prompt:${prompt.target.id}`,
              '片段提示词',
              prompt,
              [source],
            );
          } else {
            const shot = productionShots(input.document).find((s) => s.id === input.shotId)!;
            if (!isProductionPrompt(output, shot)) invalid('提示词引用不匹配当前镜头');
            const artifacts = await this.artifacts(tx, p, t.workflowRunId);
            await this.commit(
              tx,
              p,
              t.workflowRunId,
              'SHOT_RENDER',
              `customized-shot-prompt:${shot.id}`,
              `镜头提示词 · ${shot.title}`,
              output,
              [
                artifacts.find((a) => a.artifactKey === `customized-shot:${shot.id}`)!,
                ...shot.bindings
                  .map((b) =>
                    artifacts.find((a) => a.artifactKey === `customized-object:${b.assetId}`)!,
                  )
                  .filter(Boolean),
              ],
            );
          }
        } else {
          const value = output as ProductionDocument;
          if (
            !isProductionDocument(value) ||
            (!input.targetAssetId && !value.assets.some((a) => a.kind === 'PRODUCT'))
          )
            invalid('资产或分镜结果不完整');
          if (input.assetWorkflowVersion === 2) {
            const issue = validatePreparedAssets(value, input);
            if (issue) invalid(issue);
          }
          if (
            input.operation === 'SHOTS' &&
            (!productionShots(value).length ||
              workflowStateHash(value.assets) !== workflowStateHash(input.document.assets))
          )
            invalid('分镜不得修改已确认的资产目录');
          if (input.operation === 'SHOTS') {
            if (input.shotWorkflowVersion === 2) {
              const issue = validateFinalVideo(
                value,
                input,
                (t.output ?? {}) as Record<string, unknown>,
              );
              if (issue) invalid(issue);
            } else {
              const target =
                input.script.story?.beats.reduce((n, b) => n + b.durationSeconds, 0) ||
                input.script.shots.reduce((n, s) => n + s.durationSeconds, 0);
              if (
                target &&
                Math.abs(
                  productionShots(value).reduce((n, s) => n + s.durationSeconds, 0) - target,
                ) > 1
              )
                invalid('分镜总时长与故事不一致');
            }
          }
          // Re-extracting the catalog must never erase existing storyboards.
          const preserved =
            input.operation === 'ASSETS'
              ? withProductionAssets(
                  input.document,
                  mergePreparedAssets(input.document.assets, value.assets),
                )
              : value;
          let destination = t.workflowRunId;
          if (input.operation === 'ASSETS' && !input.targetAssetId) {
            const catalog = (await this.artifacts(tx, p, destination)).find(
              (a) => a.artifactKey === 'customized-asset-catalog',
            );
            if (
              !catalog ||
              workflowStateHash(catalog.payload) !== workflowStateHash({ assets: preserved.assets })
            )
              destination = await createAssetBranch(tx, p, t.workflowRunId, t.id);
          }
          const branchDocument =
            destination === t.workflowRunId ? preserved : { assets: preserved.assets, shots: [] };
          await this.writeDraft(
            tx,
            p,
            destination,
            branchDocument,
            input.sources[0]!.revision,
            destination === t.workflowRunId ? input.draftRevision : 0,
          );
          if (input.operation === 'ASSETS') {
            await this.commitAssets(tx, p, destination, branchDocument);
            const saved = t.output as Record<string, unknown> | null;
            await tx.customizedProductionTask.update({
              where: { id },
              data: {
                output: json({
                  ...(saved ?? {}),
                  final: output,
                  publishedWorkflowRunId: destination,
                }),
              },
            });
          }
        }
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            leaseExpiresAt: null,
            steps: json(
              steps.map((s) =>
                s.id === 'SAVE'
                  ? {
                      ...s,
                      status: 'SUCCEEDED',
                      content:
                        input.operation === 'ASSETS'
                          ? '资产目录已确认并保存，可继续准备图片或进入视频制作'
                          : '内容已保存，可在当前工作台查看和编辑',
                    }
                  : s,
              ),
            ),
          },
        });
        return { accepted: true };
      },
      { timeout: 30000 },
    );
  }
  fail(p: string, id: string, token: string, retryable: boolean, node?: ProductionWorkerNode) {
    return this.db.$transaction(async (tx) => {
      const t = await this.lease(tx, p, id, token, node),
        saved = (t.output ?? {}) as {
          createStarted?: boolean;
          providerTaskId?: string;
          createRejected?: boolean;
        },
        uncertain = t.operation === 'RENDER' && saved.createStarted && !saved.providerTaskId,
        retry = retryable && !uncertain && t.attemptCount < 3;
      await tx.customizedProductionTask.update({
        where: { id },
        data: {
          status: retry ? 'QUEUED' : 'FAILED',
          steps: json(
            (t.steps as unknown as ProductionStep[]).map((s) =>
              s.status === 'RUNNING' ? { ...s, status: 'FAILED' } : s,
            ),
          ),
          attemptToken: null,
          leaseExpiresAt: null,
          errorMessage: uncertain
            ? '视频创建结果尚未确认，为避免重复计费已停止自动重试，已有视频保留'
            : saved.createRejected
              ? '视频服务未受理请求，请检查模型权限与配置，已有视频保留'
              : retry
                ? '服务暂时繁忙，正在等待自动重试'
                : '本次制作未完成，已保存的内容仍然保留',
        },
      });
      if (retry) await this.enqueue(tx, t, t.attemptCount * 15000);
      return { accepted: true };
    });
  }
  action(p: string, id: string, cancel: boolean) {
    return this.db.$transaction(async (tx) => {
      await lockCustomizedProject(tx, p);
      const t = await this.task(tx, p, id);
      await this.scope(tx, p, t.workflowRunId);
      if (t.status === 'COMPLETED' || (!cancel && ['QUEUED', 'RUNNING'].includes(t.status)))
        return presentProductionTask(t);
      if (!cancel) {
        await this.valid(tx, t);
        if (
          await tx.customizedProductionTask.count({
            where: {
              projectId: p,
              workflowRunId: t.workflowRunId,
              id: { not: id },
              status: { in: ['QUEUED', 'RUNNING'] },
            },
          })
        )
          return customizedConflict('已有制作任务运行中');
      }
      let recoveryOutput: Record<string, unknown> | null = null;
      if (!cancel) {
        try {
          recoveryOutput = beginPromptMechanicalRecovery(
            t.operation,
            t.status,
            t.steps as unknown as ProductionStep[],
            t.output,
          );
        } catch (error) {
          invalid(error instanceof Error ? error.message : '机械恢复记录不可用');
        }
      }
      const updated = await tx.customizedProductionTask.update({
        where: { id },
        data: {
          status: cancel ? 'CANCELLED' : 'QUEUED',
          attemptToken: null,
          leaseExpiresAt: null,
          errorMessage: null,
          ...(!cancel ? { attemptCount: 0 } : {}),
          ...(recoveryOutput ? { output: json(recoveryOutput) } : {}),
        },
      });
      if (!cancel) await this.enqueue(tx, updated);
      return presentProductionTask(updated);
    });
  }
  async recoverExpired() {
    const rows = await this.db.customizedProductionTask.findMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
    });
    for (const row of rows)
      await this.db.$transaction(async (tx) => {
        await lockCustomizedProject(tx, row.projectId);
        const t = await this.task(tx, row.projectId, row.id);
        if (t.status !== 'RUNNING' || !t.leaseExpiresAt || t.leaseExpiresAt > new Date()) return;
        const saved = (t.output ?? {}) as { createStarted?: boolean; providerTaskId?: string };
        const retry =
          t.attemptCount < 3 &&
          !(t.operation === 'RENDER' && saved.createStarted && !saved.providerTaskId);
        await tx.customizedProductionTask.update({
          where: { id: t.id },
          data: {
            status: retry ? 'QUEUED' : 'FAILED',
            attemptToken: null,
            leaseExpiresAt: null,
            errorMessage: '执行连接中断，已保留检查点',
          },
        });
        if (retry) await this.enqueue(tx, t, 15000);
      });
  }
}
