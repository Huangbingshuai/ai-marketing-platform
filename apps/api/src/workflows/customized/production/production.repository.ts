import {
  assertWorkerOperation,
  productionQueue,
  type ProductionWorkerNode,
} from './production-worker-policy';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  isCustomizedStoryboardScript,
  isProductionDocument,
  isProductionPrompt,
  PRODUCTION_STAGES,
  productionStages,
  type ProductionDocument,
  type ProductionOperation,
  type ProductionWorkspace,
  type ProductionTask,
  type ProductionStep,
  type ProductionPrompt,
  type ProductionInput,
} from '@ai-marketing/contracts';
import type {
  Prisma,
  CustomizedProductionTask,
  WorkingArtifact,
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
  return {
    id: t.id,
    operation: t.operation as ProductionOperation,
    shotId: t.shotId,
    status: t.status as ProductionTask['status'],
    errorMessage: t.errorMessage,
    steps,
    progress:
      t.status === 'COMPLETED'
        ? 100
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
    const confirmedDocument = {
      assets:
        (catalog?.payload as unknown as { assets: ProductionDocument['assets'] })?.assets ??
        legacyAssets,
      shots:
        (plan?.payload as unknown as { shots: ProductionDocument['shots'] })?.shots ?? legacyShots,
    };
    const document =
      data?.sourceRevision === script.revision && isProductionDocument(data.document)
        ? data.document
        : confirmedDocument;
    const tasks = await tx.customizedProductionTask.findMany({
      where: { projectId: p, workflowRunId: r },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return {
      script: script.payload,
      source: { artifactId: script.id, revision: script.revision, fingerprint: script.contentHash },
      sourceReady: script.freshness === 'CURRENT',
      document,
      confirmedDocument,
      draftRevision: state?.revision ?? 0,
      assetsConfirmed: catalog?.freshness === 'CURRENT',
      shotsConfirmed: plan?.freshness === 'CURRENT',
      prompts: artifacts
        .filter((a) => a.artifactKey.startsWith('customized-shot-prompt:'))
        .map((a) => ({
          value: a.payload as unknown as ProductionPrompt,
          stale: a.freshness !== 'CURRENT',
          revision: a.revision,
        })),
      tasks: tasks.map(presentProductionTask),
    };
  }
  workspace(p: string, r: string) {
    return this.db.$transaction((tx) => this.read(tx, p, r), { timeout: 15000 });
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
        const value =
          section === 'ASSETS'
            ? {
                assets: document.assets,
                shots: w.document.shots.map((s) => ({
                  ...s,
                  bindings: (
                    document.shots.find((v) => v.id === s.id)?.bindings ?? s.bindings
                  ).filter((b) => document.assets.some((a) => a.id === b.assetId)),
                })),
              }
            : { assets: w.document.assets, shots: document.shots };
        if (!isProductionDocument(value)) invalid('镜头引用的资产已发生变化');
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
        const state = await this.writeDraft(tx, p, r, value, w.source.revision, revision);
        if (confirm) {
          const artifacts = await this.artifacts(tx, p, r),
            story = artifacts.find((a) => a.id === w.source.artifactId)!;
          if (section === 'ASSETS') {
            if (!value.assets.some((a) => a.kind === 'PRODUCT'))
              invalid('请保留独立的产品资产定义');
            for (const a of value.assets)
              await this.commit(tx, p, r, 'SHOT_PROMPT', `customized-object:${a.id}`, a.name, a, [
                story,
              ]);
            // Removed objects invalidate only their actual dependent shots/prompts.
            for (const a of artifacts.filter(
              (a) =>
                a.artifactKey.startsWith('customized-object:') &&
                !value.assets.some((v) => `customized-object:${v.id}` === a.artifactKey),
            ))
              await this.commit(tx, p, r, 'SHOT_PROMPT', a.artifactKey, a.name, { removed: true }, [
                story,
              ]);
            await this.commit(
              tx,
              p,
              r,
              'SHOT_PROMPT',
              'customized-asset-catalog',
              '资产目录',
              { assets: value.assets },
              [story],
            );
          } else {
            if (
              !w.assetsConfirmed ||
              !value.shots.length ||
              value.shots.some((s) => !s.visual.trim())
            )
              invalid('请确认资产目录并补齐分镜画面');
            const objects = await this.artifacts(tx, p, r);
            const catalog = objects.find((a) => a.artifactKey === 'customized-asset-catalog');
            if (
              !catalog ||
              workflowStateHash(catalog.payload) !== workflowStateHash({ assets: value.assets })
            )
              return customizedConflict('资产目录有未确认修改，请先保存资产准备');
            for (const s of value.shots)
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
                !value.shots.some((s) => `customized-shot:${s.id}` === a.artifactKey),
            ))
              await this.commit(tx, p, r, 'SHOT_RENDER', a.artifactKey, a.name, { removed: true }, [
                story,
              ]);
            await this.commit(
              tx,
              p,
              r,
              'SHOT_RENDER',
              'customized-video-plan',
              '分镜制作',
              { shots: value.shots },
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
  savePrompt(p: string, r: string, revision: number, prompt: ProductionPrompt) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const w = await this.read(tx, p, r),
          shot = w.document.shots.find((s) => s.id === prompt.shotId);
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
  ) {
    return this.db.$transaction(
      async (tx) => {
        await lockCustomizedProject(tx, p);
        const w = await this.read(tx, p, r);
        const previous = await tx.customizedProductionTask.findUnique({
          where: { projectId_idempotencyKey: { projectId: p, idempotencyKey: key } },
        });
        if (previous) {
          if (
            previous.workflowRunId !== r ||
            previous.operation !== operation ||
            previous.shotId !== shotId
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
        const artifacts = await this.artifacts(tx, p, r);
        const source = [artifacts.find((a) => a.id === w.source.artifactId)!];
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
        if (operation === 'PROMPT') {
          const shot = w.document.shots.find((s) => s.id === shotId),
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
              productionStages(operation).map((s) => ({
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
    if ((state?.revision ?? 0) !== input.draftRevision)
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
        !PRODUCTION_STAGES.some((s) => s.id === step.id) ||
        step.id === 'SAVE' ||
        !['RUNNING', 'SUCCEEDED', 'FAILED'].includes(step.status)
      )
        invalid('执行步骤不正确');
      if (JSON.stringify(output ?? null).length > 2_000_000 || step.content.length > 100000)
        invalid('结果超过大小限制');
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
        if (
          !steps.filter((s) => s.id !== 'SAVE').every((s) => s.status === 'SUCCEEDED') ||
          workflowStateHash(output) !==
            workflowStateHash((t.output as Record<string, unknown> | null)?.final ?? t.output)
        )
          return customizedConflict('内容尚未完成审校');
        if (input.operation === 'PROMPT') {
          const shot = input.document.shots.find((s) => s.id === input.shotId)!;
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
        } else {
          const value = output as ProductionDocument;
          if (!isProductionDocument(value) || !value.assets.some((a) => a.kind === 'PRODUCT'))
            invalid('资产或分镜结果不完整');
          if (
            input.operation === 'SHOTS' &&
            (!value.shots.length ||
              workflowStateHash(value.assets) !== workflowStateHash(input.document.assets))
          )
            invalid('分镜不得修改已确认的资产目录');
          if (input.operation === 'SHOTS') {
            const target =
              input.script.story?.beats.reduce((n, b) => n + b.durationSeconds, 0) ||
              input.script.shots.reduce((n, s) => n + s.durationSeconds, 0);
            if (
              target &&
              Math.abs(value.shots.reduce((n, s) => n + s.durationSeconds, 0) - target) > 1
            )
              invalid('分镜总时长与故事不一致');
          }
          // Re-extracting the catalog must never erase existing storyboards.
          const preserved =
            input.operation === 'ASSETS'
              ? {
                  ...value,
                  shots: input.document.shots.map((s) => ({
                    ...s,
                    bindings: s.bindings.filter((b) =>
                      value.assets.some((a) => a.id === b.assetId),
                    ),
                  })),
                }
              : value;
          await this.writeDraft(
            tx,
            p,
            t.workflowRunId,
            preserved,
            input.sources[0]!.revision,
            input.draftRevision,
          );
        }
        await tx.customizedProductionTask.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            leaseExpiresAt: null,
            steps: json(
              steps.map((s) =>
                s.id === 'SAVE'
                  ? { ...s, status: 'SUCCEEDED', content: '内容已保存，可在当前工作台查看和编辑' }
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
        retry = retryable && t.attemptCount < 3;
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
          errorMessage: retry
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
      const updated = await tx.customizedProductionTask.update({
        where: { id },
        data: {
          status: cancel ? 'CANCELLED' : 'QUEUED',
          attemptToken: null,
          leaseExpiresAt: null,
          errorMessage: null,
          ...(!cancel ? { attemptCount: 0 } : {}),
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
        const retry = t.attemptCount < 3;
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
