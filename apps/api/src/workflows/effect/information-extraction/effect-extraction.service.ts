import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';

import type {
  EffectExtractionNodeExecution,
  EffectExtractionNodeId,
  EffectExtractionProductState,
  EffectExtractionProvenance,
  EffectExtractionResult,
  EffectExtractionRun,
  EffectExtractionSemanticField,
  EffectExtractionSemanticNotice,
  EffectExtractionSemanticNoticeIssue,
  EffectExtractionValueOrigin,
  EffectVideoConfig,
  EffectVideoConfigOverride,
  GetEffectExtractionRunData,
  GetEffectExtractionNodeDetailData,
  GetEffectExtractionWorkspaceData,
  StartEffectExtractionRunData,
  UpdateEffectExtractionResultData,
  ValidateEffectExtractionResultData,
} from '@ai-marketing/contracts';
import {
  EFFECT_EXTRACTION_GRAPH_NODES,
  EFFECT_EXTRACTION_SCHEMA_VERSION,
  mergeEffectVideoConfig,
} from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';

import { ApiHttpException } from '../../../common/api-http-exception';
import { ProjectService } from '../../../platform/project/project.service';
import { WorkflowWorkingService } from '../../../platform/workflow/workflow-working.service';
import { workingArtifactContentHash } from '../../../platform/workflow/workflow-working.repository';
import { JOB_PROGRESS_STORE } from '../../../platform/job/job.constants';
import type { JobProgressStore } from '../../../platform/job/job.ports';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { EffectExtractionRepository } from './effect-extraction.repository';
import { presentExtractionNodeDetail } from './effect-extraction-node-detail';
import {
  EFFECT_EXTRACTION_ARTIFACT_KINDS,
  type CompleteRunInput,
  type EffectExtractionArtifactKind,
  type EffectExtractionInputSnapshot,
} from './effect-extraction.types';
import {
  effectExtractionDefaultsFromConfig,
  extractionSourceFingerprint,
  isLegacyEffectExtractionResultWithoutCanonicalAudiences,
  isLegacyEffectExtractionResultWithoutResolution,
  isSupportedExtractionMaterial,
  isEffectExtractionResult,
  manualOverrideFieldNames,
  manualOverridesForResult,
  parseWarnings,
  toEditableEffectExtractionResultV2,
  toEffectExtractionResultV2,
} from './effect-extraction.validation';

const notFound = (message = 'AI 提炼实体不存在') =>
  new ApiHttpException(message, HttpStatus.NOT_FOUND, 'ASSET_NOT_FOUND');
const conflict = (message: string) =>
  new ApiHttpException(message, HttpStatus.CONFLICT, 'CONFLICT');
const badRequest = (message: string) =>
  new ApiHttpException(message, HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR');

export type UploadedExtractionArtifact = {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
};

const safeFileName = (value: string): string =>
  (
    [...(value.split(/[\\/]/).at(-1) ?? 'artifact.md')]
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      })
      .join('') || 'artifact.md'
  ).slice(0, 255);

type RunBranchRecord = {
  branch:
    'DOCUMENT' | 'IMAGE' | 'COMMERCE' | 'FORM' | 'FUSION' | 'SEMANTIC_REFINEMENT' | 'NORMALIZATION';
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'SKIPPED' | 'FAILED';
  warnings: unknown;
  errorCode?: string | null;
  errorMessage: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
};

const isRetiredFormCompletenessWarning = (warning: { message: string }): boolean =>
  /^表单尚未填写.+，将由其他资料补充$/u.test(warning.message);

const comparableMessage = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/gu, ' ').trim();

const publicWarnings = (
  value: unknown,
  excludedMessages: Array<string | null | undefined> = [],
) => {
  const excluded = new Set(excludedMessages.map(comparableMessage).filter(Boolean));
  const seen = new Set<string>();
  return parseWarnings(value).filter((warning) => {
    if (isRetiredFormCompletenessWarning(warning)) return false;
    const message = comparableMessage(warning.message);
    if (!message || excluded.has(message) || seen.has(message)) return false;
    seen.add(message);
    return true;
  });
};

const publicRunErrorMessage = (record: {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  currentNode: string | null;
  errorMessage: string | null;
}): string | null =>
  record.status === 'FAILED' &&
  record.currentNode === 'NORMALIZATION' &&
  /^internal API returned HTTP \d{3}$/u.test(record.errorMessage ?? '')
    ? '结果保存失败，请重新提炼'
    : record.errorMessage;

const publicBranchErrorMessage = (
  nodeId: EffectExtractionNodeId,
  branch: RunBranchRecord,
  fallback: string | null,
  runCreatedAt?: Date,
): string | null => {
  const message = branch.errorMessage ?? fallback;
  if (nodeId !== 'DOCUMENT' || !message) return message;
  if (branch.errorCode === 'DOCUMENT_AI_TIMEOUT') return '文档 AI 抽取超时';
  const branchElapsedMs =
    branch.startedAt && branch.completedAt
      ? branch.completedAt.getTime() - branch.startedAt.getTime()
      : 0;
  const elapsedMs =
    branchElapsedMs > 0
      ? branchElapsedMs
      : branch.completedAt && runCreatedAt
        ? branch.completedAt.getTime() - runCreatedAt.getTime()
        : 0;
  return message === 'Ark structured-output request failed' && elapsedMs >= 100_000
    ? '文档 AI 抽取超时'
    : message;
};

const presentNodes = (record: {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  currentNode: string | null;
  errorMessage: string | null;
  createdAt?: Date;
  branches?: RunBranchRecord[];
}): EffectExtractionNodeExecution[] => {
  const branches = new Map((record.branches ?? []).map((branch) => [branch.branch, branch]));
  const runErrorMessage = publicRunErrorMessage(record);
  const snapshotStatus: EffectExtractionNodeExecution['status'] =
    record.status === 'QUEUED'
      ? 'PENDING'
      : record.status === 'FAILED' && branches.size === 0
        ? 'FAILED'
        : record.status === 'RUNNING' &&
            (record.currentNode === 'LOAD_AND_SNAPSHOT' || branches.size === 0)
          ? 'RUNNING'
          : 'SUCCEEDED';

  return EFFECT_EXTRACTION_GRAPH_NODES.map(({ id }) => {
    if (id === 'LOAD_AND_SNAPSHOT') {
      return {
        nodeId: id,
        status: snapshotStatus,
        warnings: [],
        errorMessage: snapshotStatus === 'FAILED' ? runErrorMessage : null,
      };
    }
    const branch = branches.get(id);
    if (!branch) return { nodeId: id, status: 'PENDING', warnings: [], errorMessage: null };
    const failedWithRun =
      record.status === 'FAILED' && (branch.status === 'RUNNING' || record.currentNode === id);
    const errorMessage = publicBranchErrorMessage(
      id,
      branch,
      failedWithRun ? runErrorMessage : null,
      record.createdAt,
    );
    const warnings = publicWarnings(branch.warnings, [errorMessage, branch.errorMessage]);
    const retiredPartial =
      id === 'FORM' && branch.status === 'PARTIAL' && warnings.length === 0 && !branch.errorMessage;
    return {
      nodeId: id,
      status: failedWithRun ? 'FAILED' : retiredPartial ? 'SUCCEEDED' : branch.status,
      warnings,
      errorMessage,
    };
  });
};

const presentRun = (
  record: {
    id: string;
    projectId: string;
    draftId: string;
    productId: string;
    status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
    progress: number;
    currentNode: string | null;
    warnings: unknown;
    errorMessage: string | null;
    branches?: RunBranchRecord[];
    createdAt: Date;
    updatedAt: Date;
  },
  extractResultId: string | null,
): EffectExtractionRun => ({
  id: record.id,
  projectId: record.projectId,
  draftId: record.draftId,
  productId: record.productId,
  status: record.status,
  progress: record.progress,
  currentNode: record.currentNode,
  warnings: publicWarnings(record.warnings),
  errorMessage: publicRunErrorMessage(record),
  extractResultId,
  nodes: presentNodes(record),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

@Injectable()
export class EffectExtractionService {
  constructor(
    @Inject(EffectExtractionRepository) private readonly repository: EffectExtractionRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(JOB_PROGRESS_STORE) private readonly progressStore: JobProgressStore,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Optional()
    @Inject(WorkflowWorkingService)
    private readonly workingService?: WorkflowWorkingService,
  ) {}

  private async workingResultInput(record: {
    id: string;
    projectId: string;
    draftId: string;
    productId: string;
    runId: string;
    draftResult: unknown;
  }) {
    const activeProduct = await this.repository.product(record.projectId, record.productId);
    const workflow = await this.repository.workflowRunForDraft(record.projectId, record.draftId);
    const sourceRun = await this.repository.run(record.projectId, record.runId);
    const snapshot = sourceRun?.inputSnapshot as EffectExtractionInputSnapshot | undefined;
    const snapshotProduct = snapshot?.product;
    if (!activeProduct || !workflow || !snapshot || !snapshotProduct?.name.trim()) return null;
    const productName = snapshotProduct.name.trim();
    const config = snapshot.globalVideoConfig ?? snapshotProduct.effectiveConfig;
    const result = toEffectExtractionResultV2(
      record.draftResult,
      effectExtractionDefaultsFromConfig(config),
    );
    return {
      workflowRunId: workflow.workspace.workflowRunId,
      artifactKey: `marketing-insight:${record.productId}`,
      input: {
        kind: 'STRUCTURED' as const,
        name: `${productName} AI 信息提炼`.slice(0, 120),
        directory: 'INSIGHTS' as const,
        type: 'INSIGHT_RESULT' as const,
        tags: [productName, snapshotProduct.category, snapshotProduct.sku]
          .filter(Boolean)
          .slice(0, 20),
        sourceArtifactId: record.id,
        sourceRunId: record.runId,
        metadata: {
          productId: record.productId,
          productName,
          contentKind: 'EFFECT_EXTRACTION_RESULT',
        },
        payload: result,
        dependencies: snapshot.dependencies ?? [],
      },
    };
  }

  private async syncNodeStateBaseline(record: {
    id: string;
    projectId: string;
    draftId: string;
    productId: string;
    revision: number;
    draftResult: unknown;
  }): Promise<void> {
    const workflow = await this.repository.workflowRunForDraft(record.projectId, record.draftId);
    if (!workflow || !this.workingService) return;
    const existingState = await this.workingService.getNodeStateOrNull(
      record.projectId,
      workflow.workspace.workflowRunId,
      'INFORMATION_EXTRACTION',
    );
    const existingPayload =
      existingState?.state && typeof existingState.state === 'object'
        ? (existingState.state as { products?: Record<string, unknown> })
        : {};
    await this.workingService.replaceNodeStateBaseline(
      record.projectId,
      workflow.workspace.workflowRunId,
      'INFORMATION_EXTRACTION',
      {
        ...existingPayload,
        products: {
          ...(existingPayload.products ?? {}),
          [record.productId]: {
            resultId: record.id,
            result: record.draftResult,
            sourceResultRevision: record.revision,
          },
        },
      },
    );
  }

  private async currentFingerprint(
    draft: Awaited<ReturnType<EffectExtractionRepository['workspace']>>,
    productId: string,
  ): Promise<string> {
    if (!draft) return '';
    const product = draft.products.find((item) => item.id === productId);
    if (!product) return '';
    const dependencySnapshot = await this.repository.currentDependencySnapshot(
      draft.projectId,
      productId,
    );
    if (!dependencySnapshot) return '';
    const snapshot: EffectExtractionInputSnapshot = {
      schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
      projectId: draft.projectId,
      draftId: draft.id,
      mode: draft.mode,
      sourceRevision: draft.revision,
      globalVideoConfig: draft.globalConfig as EffectVideoConfig,
      product: {
        id: product.id,
        name: product.name,
        category: product.category,
        sku: product.sku,
        commerceUrl: product.commerceUrl,
        effectiveConfig: mergeEffectVideoConfig(
          draft.globalConfig as EffectVideoConfig,
          product.configOverride as EffectVideoConfigOverride,
        ),
      },
      materials: product.materials
        .filter(
          (material) =>
            material.status === 'READY' &&
            isSupportedExtractionMaterial(material.mimeType, material.originalFileName) &&
            material.storageKey &&
            material.originalFileName &&
            material.mimeType &&
            material.sizeBytes,
        )
        .map((material) => ({
          id: material.id,
          type: material.type,
          originalFileName: material.originalFileName!,
          mimeType: material.mimeType!,
          sizeBytes: material.sizeBytes!,
          storageKey: material.storageKey!,
          updatedAt: material.updatedAt.toISOString(),
        })),
      dependencySnapshot,
    };
    return extractionSourceFingerprint(snapshot);
  }

  async workspace(projectId: string, draftId: string): Promise<GetEffectExtractionWorkspaceData> {
    await this.projects.get(projectId);
    const draft = await this.repository.workspace(projectId, draftId);
    if (!draft) throw notFound('效果类资料草稿不存在');
    const products: EffectExtractionProductState[] = await Promise.all(
      draft.products.map(async (product) => {
        const run = product.extractionRuns[0] ?? null;
        const result = run?.result ?? null;
        const config = mergeEffectVideoConfig(
          draft.globalConfig as EffectVideoConfig,
          product.configOverride as EffectVideoConfigOverride,
        );
        const resultV2 = result
          ? toEffectExtractionResultV2(
              result.draftResult,
              effectExtractionDefaultsFromConfig(config),
            )
          : null;
        const manualOverrideFields = manualOverrideFieldNames(result?.manualOverrides);
        const provenance = extractionValueProvenance(
          resultV2,
          run?.branches ?? [],
          manualOverrideFields,
          product.materials,
        );
        const fingerprint = await this.currentFingerprint(draft, product.id);
        const stale = Boolean(result && result.sourceFingerprint !== fingerprint);
        const candidate = result ? await this.workingResultInput(result) : null;
        const artifact = await this.repository.insightArtifact(projectId, draftId, product.id);
        const commitStatus = !artifact
          ? 'UNVALIDATED'
          : stale || artifact.freshness !== 'CURRENT' || artifact.availability !== 'AVAILABLE'
            ? 'STALE'
            : candidate && artifact.contentHash === workingArtifactContentHash(candidate.input)
              ? 'COMMITTED'
              : 'DRAFT_CHANGED';
        const status = !run
          ? 'NOT_GENERATED'
          : stale
            ? 'STALE'
            : run.status === 'RUNNING'
              ? 'PROCESSING'
              : run.status;
        return {
          projectId,
          draftId,
          productId: product.id,
          status,
          runId: run?.id ?? null,
          resultId: result?.id ?? null,
          resultSchemaVersion: result?.schemaVersion ?? null,
          resultRevision: result?.revision ?? null,
          result: resultV2,
          provenance,
          manualOverrideFields,
          progress: run?.progress ?? 0,
          currentNode: run?.currentNode ?? null,
          warnings: publicWarnings(run?.warnings),
          errorMessage: run ? publicRunErrorMessage(run) : null,
          sourceFingerprint: fingerprint,
          commitStatus,
          workingArtifactRevision: artifact?.revision ?? null,
          updatedAt: (run?.updatedAt ?? product.updatedAt).toISOString(),
        };
      }),
    );
    return {
      projectId,
      draftId,
      mode: draft.mode,
      sourceRevision: draft.revision,
      products,
    };
  }

  async start(
    projectId: string,
    productId: string,
    input: {
      draftId: string;
      expectedRevision: number;
      idempotencyKey: string;
      refreshImageRecognition?: boolean;
    },
  ): Promise<StartEffectExtractionRunData> {
    await this.projects.get(projectId);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('幂等键不能为空');
    const result = await this.repository.startRun(
      projectId,
      input.draftId,
      productId,
      input.expectedRevision,
      idempotencyKey,
      input.refreshImageRecognition ?? false,
    );
    if (result.kind === 'NOT_FOUND') throw notFound('资料草稿或产品不存在');
    if (result.kind === 'REVISION_CONFLICT') throw conflict('资料草稿已更新，请刷新后重试');
    if (result.kind === 'NOT_READY') throw conflict('资料导入节点尚未完成或资料不完整');
    if (result.kind === 'ACTIVE_CONFLICT') throw conflict('当前产品已有进行中的提炼任务');
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他提炼请求');
    const replay =
      result.kind === 'REPLAYED' ? await this.repository.run(projectId, result.run.id) : null;
    return {
      run: presentRun(replay ?? result.run, replay?.result?.id ?? null),
    };
  }

  async run(projectId: string, runId: string): Promise<GetEffectExtractionRunData> {
    await this.projects.get(projectId);
    const record = await this.repository.run(projectId, runId);
    if (!record) throw notFound('提炼任务不存在');
    if (record.status === 'QUEUED' || record.status === 'RUNNING') {
      try {
        const cached = await this.progressStore.get(projectId, runId);
        if (cached) {
          record.progress = Math.max(record.progress, cached.progress);
          record.currentNode = cached.currentNode;
        }
      } catch {
        // Redis is an optimization; database status remains authoritative.
      }
    }
    return { run: presentRun(record, record.result?.id ?? null) };
  }

  async nodeDetail(
    projectId: string,
    runId: string,
    rawNodeId: string,
  ): Promise<GetEffectExtractionNodeDetailData> {
    await this.projects.get(projectId);
    const definition = EFFECT_EXTRACTION_GRAPH_NODES.find(({ id }) => id === rawNodeId);
    if (!definition) throw badRequest('未知的提炼节点');
    const record = await this.repository.run(projectId, runId);
    if (!record) throw notFound('提炼任务不存在');
    const nodeId = definition.id as EffectExtractionNodeId;
    const execution = presentNodes(record).find((node) => node.nodeId === nodeId)!;
    return { detail: presentExtractionNodeDetail(record, nodeId, execution) };
  }

  async updateResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
    result: unknown,
  ): Promise<UpdateEffectExtractionResultData> {
    await this.projects.get(projectId);
    if (!isEffectExtractionResult(result)) throw badRequest('提炼结果不符合标准结构');
    const existing = await this.repository.result(projectId, resultId);
    if (!existing) throw notFound('提炼结果不存在');
    const sourceRun = await this.repository.run(projectId, existing.runId);
    const snapshot = sourceRun?.inputSnapshot as EffectExtractionInputSnapshot | undefined;
    if (!snapshot) throw conflict('提炼输入快照不存在，请重新提炼');
    const config = snapshot.globalVideoConfig ?? snapshot.product.effectiveConfig;
    const generated = toEffectExtractionResultV2(
      existing.generatedResult,
      effectExtractionDefaultsFromConfig(config),
    );
    const editableResult: EffectExtractionResult = {
      ...result,
      disabledElements: [...new Set([...config.disabledElements, ...result.disabledElements])],
    };
    const manualOverrides = manualOverridesForResult(generated, editableResult);
    const updated = await this.repository.updateResult(
      projectId,
      resultId,
      expectedRevision,
      editableResult,
      manualOverrides,
    );
    if (!updated) throw conflict('提炼结果已被其他操作更新，请刷新后重试');
    return {
      projectId,
      productId: updated.productId,
      resultId: updated.id,
      revision: updated.revision,
      result: updated.draftResult as EffectExtractionResult,
      savedAt: updated.savedAt!.toISOString(),
    };
  }

  async validateResult(
    projectId: string,
    resultId: string,
    expectedRevision: number,
  ): Promise<ValidateEffectExtractionResultData> {
    await this.projects.get(projectId);
    const existing = await this.repository.result(projectId, resultId);
    if (!existing) throw notFound('提炼结果不存在');
    if (existing.revision !== expectedRevision)
      throw conflict('提炼结果已被其他操作更新，请刷新后重试');
    const sourceRun = await this.repository.run(projectId, existing.runId);
    const snapshot = sourceRun?.inputSnapshot as EffectExtractionInputSnapshot | undefined;
    if (!snapshot) throw conflict('提炼输入快照不存在，请重新提炼');
    const config = snapshot.globalVideoConfig ?? snapshot.product.effectiveConfig;
    const draftResult = toEditableEffectExtractionResultV2(
      existing.draftResult,
      effectExtractionDefaultsFromConfig(config),
    );
    if (!isEffectExtractionResult(draftResult))
      return {
        valid: false,
        issues: [{ code: 'INVALID_RESULT', message: '提炼结果不符合标准结构' }],
        subjectKey: existing.productId,
        productId: existing.productId,
        artifacts: [],
        allProductsValidated: false,
        validatedAt: new Date().toISOString(),
      };
    existing.draftResult = draftResult as never;
    if (await this.repository.hasNewerWorkingResult(projectId, existing.productId, existing.runId))
      throw conflict('当前结果已不是最新提炼结果，请刷新后完成校验');
    const candidate = await this.workingResultInput(existing);
    if (!candidate) throw conflict('提炼依赖快照不完整，请重新提炼');
    let committed;
    try {
      committed = await this.repository.commitValidatedResult(
        projectId,
        resultId,
        expectedRevision,
        candidate.workflowRunId,
        candidate.artifactKey,
        candidate.input,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === 'WORKING_ARTIFACT_DEPENDENCY_CONFLICT' ||
          error.message === 'WORKFLOW_EXECUTION_INPUT_DEPENDENCY_CONFLICT')
      )
        throw conflict('上游资料或提炼参数已经变化，请重新提炼后再校验');
      throw error;
    }
    if (committed.kind !== 'COMMITTED') {
      if (committed.kind === 'NOT_FOUND') throw notFound('提炼结果不存在');
      if (committed.kind === 'REVISION_CONFLICT')
        throw conflict('提炼结果已被其他操作更新，请刷新后重试');
      throw conflict('当前结果不是最新已完成提炼结果，请重新提炼后再校验');
    }
    const workspace = await this.workspace(projectId, existing.draftId);
    return {
      valid: true,
      issues: [],
      subjectKey: existing.productId,
      productId: existing.productId,
      artifacts: [committed.artifact],
      allProductsValidated: workspace.products.every(
        (product) => product.commitStatus === 'COMMITTED',
      ),
      validatedAt: new Date().toISOString(),
    };
  }

  async claim(projectId: string, runId: string) {
    const result = await this.repository.claim(projectId, runId);
    if (result.kind === 'NOT_FOUND') throw notFound('提炼任务不存在');
    if (result.kind === 'BUSY') throw conflict('提炼任务已被其他 Worker 认领');
    if (result.kind === 'TERMINAL' || result.kind === 'ATTEMPTS_EXHAUSTED')
      return { terminal: true as const, runId };
    return {
      terminal: false as const,
      runId,
      attemptToken: result.attemptToken,
      sourceFingerprint: result.run.sourceFingerprint,
      input: result.inputSnapshot,
    };
  }

  async progress(
    projectId: string,
    runId: string,
    attemptToken: string,
    progress: number,
    currentNode: string,
  ) {
    if (!(await this.repository.progress(projectId, runId, attemptToken, progress, currentNode)))
      throw conflict('Worker 租约已失效');
    try {
      await this.progressStore.set({
        projectId,
        runId,
        progress,
        currentNode,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // Redis failure must not fail the task heartbeat.
    }
    return { accepted: true as const };
  }

  async saveBranch(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: Parameters<EffectExtractionRepository['saveBranch']>[3],
  ) {
    if (!(await this.repository.saveBranch(projectId, runId, attemptToken, input)))
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  async branches(projectId: string, runId: string, attemptToken: string) {
    const records = await this.repository.branches(projectId, runId, attemptToken);
    if (!records) throw conflict('Worker 租约已失效');
    return {
      runId,
      branches: records.map((record) => ({
        branch: record.branch,
        status: record.status,
        structuredOutput: record.structuredOutput,
        textStorageKey: record.textStorageKey,
        warnings: parseWarnings(record.warnings),
        errorCode: record.errorCode,
        errorMessage: record.errorMessage,
        updatedAt: record.updatedAt.toISOString(),
      })),
    };
  }

  async imageCache(projectId: string, runId: string, attemptToken: string, cacheKey: string) {
    const result = await this.repository.imageCache(projectId, runId, attemptToken, cacheKey);
    if (!result.authorized) throw conflict('Worker 租约已失效');
    if (!result.record) return { hit: false as const };
    return {
      hit: true as const,
      candidate: result.record.candidate,
      metadata: result.record.metadata,
    };
  }

  async saveImageCache(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: {
      cacheKey: string;
      candidate: Record<string, unknown>;
      metadata: Record<string, unknown>;
    },
  ) {
    if (!(await this.repository.saveImageCache(projectId, runId, attemptToken, input)))
      throw conflict('Worker 租约已失效');
    return { accepted: true as const };
  }

  async storeArtifact(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: {
      artifactKind: EffectExtractionArtifactKind;
      sourceId?: string | undefined;
      idempotencyKey: string;
    },
    file: UploadedExtractionArtifact | undefined,
  ) {
    if (!file || file.size < 1) throw badRequest('请选择要上传的提炼产物文件');
    const fileName = safeFileName(file.originalname);
    if (
      !EFFECT_EXTRACTION_ARTIFACT_KINDS.includes(input.artifactKind) ||
      (!fileName.toLowerCase().endsWith('.md') &&
        !['text/markdown', 'text/plain'].includes(file.mimetype.toLowerCase()))
    )
      throw badRequest('提炼产物必须是 Markdown 文本');
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw badRequest('产物幂等键不能为空');
    const run = await this.repository.authorizedRun(projectId, runId, attemptToken);
    if (!run) throw conflict('Worker 租约已失效');
    const existing = await this.repository.artifactByKey(projectId, runId, idempotencyKey);
    if (existing) {
      if (
        existing.artifactKind !== input.artifactKind ||
        existing.sourceId !== (input.sourceId?.trim() || null)
      )
        throw conflict('产物幂等键已用于其他请求');
      await rm(file.path, { force: true }).catch(() => undefined);
      return {
        artifactId: existing.id,
        storageKey: existing.storageKey,
        sizeBytes: existing.sizeBytes,
        replayed: true,
      };
    }
    const project = await this.projects.get(projectId);
    const snapshot = run.inputSnapshot as EffectExtractionInputSnapshot;
    let stored: { key: string; sizeBytes: number } | null = null;
    try {
      stored = await this.storage.put({
        projectId,
        stream: createReadStream(file.path),
        sizeBytes: file.size,
        contentType: file.mimetype || 'text/markdown',
        keyContext: {
          projectName: project.name,
          workflow: 'EFFECT',
          lifecycle: 'staging',
          productId: run.productId,
          productName: snapshot.product.name,
          category: 'AI提炼中间产物',
          originalFileName: fileName,
        },
      });
      try {
        const artifact = await this.repository.createArtifact(projectId, runId, attemptToken, {
          artifactKind: input.artifactKind,
          sourceId: input.sourceId?.trim() || null,
          idempotencyKey,
          originalFileName: fileName,
          mimeType: file.mimetype || 'text/markdown',
          sizeBytes: stored.sizeBytes,
          storageKey: stored.key,
        });
        if (!artifact) throw conflict('Worker 租约已失效');
        return {
          artifactId: artifact.id,
          storageKey: artifact.storageKey,
          sizeBytes: artifact.sizeBytes,
          replayed: false,
        };
      } catch (error) {
        const raced = await this.repository.artifactByKey(projectId, runId, idempotencyKey);
        if (raced) {
          if (
            raced.artifactKind !== input.artifactKind ||
            raced.sourceId !== (input.sourceId?.trim() || null)
          )
            throw conflict('产物幂等键已用于其他请求');
          await this.storage.delete(stored.key).catch(() => undefined);
          return {
            artifactId: raced.id,
            storageKey: raced.storageKey,
            sizeBytes: raced.sizeBytes,
            replayed: true,
          };
        }
        throw error;
      }
    } catch (error) {
      if (stored) await this.storage.delete(stored.key).catch(() => undefined);
      throw error;
    } finally {
      await rm(file.path, { force: true }).catch(() => undefined);
    }
  }

  async complete(projectId: string, runId: string, attemptToken: string, input: CompleteRunInput) {
    if (
      !isEffectExtractionResult(input.result) &&
      !isLegacyEffectExtractionResultWithoutCanonicalAudiences(input.result) &&
      !isLegacyEffectExtractionResultWithoutResolution(input.result)
    )
      throw badRequest('标准化结果不符合统一结构');
    const result = await this.repository.complete(projectId, runId, attemptToken, input);
    if (result.kind === 'NOT_FOUND') throw notFound('提炼任务不存在');
    if (result.kind === 'LEASE_CONFLICT') throw conflict('Worker 租约已失效');
    await this.syncNodeStateBaseline(result.result);
    try {
      await this.progressStore.delete(projectId, runId);
    } catch {
      // Terminal state is already persisted.
    }
    return { extractResultId: result.result.id };
  }

  async fail(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: {
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
      warnings: Parameters<typeof parseWarnings>[0];
    },
  ) {
    const status = await this.repository.fail(projectId, runId, attemptToken, {
      ...input,
      warnings: parseWarnings(input.warnings),
    });
    if (status === 'NOT_FOUND') throw notFound('提炼任务不存在');
    if (status === 'LEASE_CONFLICT') throw conflict('Worker 租约已失效');
    try {
      await this.progressStore.delete(projectId, runId);
    } catch {
      // Database state remains authoritative.
    }
    return { status };
  }

  async source(projectId: string, runId: string, materialId: string, attemptToken: string) {
    const material = await this.repository.source(projectId, runId, materialId, attemptToken);
    if (!material) throw notFound('提炼源文件不存在或 Worker 租约已失效');
    return { material, ...(await this.storage.open(material.storageKey)) };
  }
}

type ExtractionOriginBranch = {
  branch: string;
  structuredOutput: unknown;
};

type ExtractionOriginMaterial = {
  id: string;
  originalFileName: string | null;
};

const EXTRACTION_LIST_FIELDS = [
  'coreSellingPoints',
  'secondarySellingPoints',
  'trustBackings',
  'targetAudiences',
  'corePainPoints',
  'decisionDrivers',
  'usageScenarios',
  'purchaseScenarios',
  'emotionalScenarios',
  'disabledElements',
] as const satisfies readonly (keyof EffectExtractionResult)[];

const normalizeOriginValue = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toLocaleLowerCase() : String(value);

const snakeCaseField = (field: string): string =>
  field.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);

const branchCandidates = (structuredOutput: unknown): Record<string, unknown>[] => {
  if (!structuredOutput || typeof structuredOutput !== 'object' || Array.isArray(structuredOutput))
    return [];
  const payload = structuredOutput as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [];
  if (
    payload.candidate &&
    typeof payload.candidate === 'object' &&
    !Array.isArray(payload.candidate)
  )
    candidates.push(payload.candidate as Record<string, unknown>);
  if (Array.isArray(payload.items)) {
    for (const item of payload.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const candidate = (item as Record<string, unknown>).candidate;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate))
        candidates.push(candidate as Record<string, unknown>);
    }
  }
  return candidates;
};

const candidateFieldValues = (
  candidates: readonly Record<string, unknown>[],
  field: keyof EffectExtractionResult,
): Set<string> => {
  const values = new Set<string>();
  for (const candidate of candidates) {
    const rawFields =
      field === 'secondarySellingPoints'
        ? (['secondarySellingPoints', 'coreSellingPoints'] as const)
        : ([field] as const);
    for (const rawField of rawFields) {
      const raw =
        rawField === 'targetAudiences'
          ? (candidate.targetAudiences ?? candidate.targetAudience ?? candidate.target_audience)
          : (candidate[rawField] ?? candidate[snakeCaseField(rawField)]);
      const rawValues =
        rawField === 'targetAudiences' && typeof raw === 'string'
          ? raw.split(/[\n,，、;；]+/u)
          : Array.isArray(raw)
            ? raw
            : [raw];
      for (const value of rawValues) {
        if (value !== null && value !== undefined && value !== '')
          values.add(normalizeOriginValue(value));
      }
    }
  }
  return values;
};

const SEMANTIC_NOTICE_FIELDS = new Set<EffectExtractionSemanticField>([
  'coreSellingPoints',
  'secondarySellingPoints',
  'corePainPoints',
  'decisionDrivers',
  'usageScenarios',
  'purchaseScenarios',
  'emotionalScenarios',
]);

const SEMANTIC_NOTICE_ISSUES = new Set<EffectExtractionSemanticNoticeIssue>([
  'POSSIBLE_DUPLICATE',
  'POSSIBLE_OVERLAP',
  'POSSIBLE_WRONG_FIELD',
  'AMBIGUOUS_EXPRESSION',
  'FIELD_OVER_RECOMMENDED_COUNT',
]);

const SEMANTIC_FIELD_LABELS: Record<EffectExtractionSemanticField, string> = {
  coreSellingPoints: '核心卖点',
  secondarySellingPoints: '次要卖点',
  corePainPoints: '核心痛点',
  decisionDrivers: '决策动因',
  usageScenarios: '核心使用场景',
  purchaseScenarios: '购买场景',
  emotionalScenarios: '情绪共鸣场景',
};

const safeSemanticValue = (value: unknown): string =>
  String(value ?? '')
    .replace(/data:[^\s,]+;base64,[a-z\d+/=]+/giu, '')
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);

const semanticNoticeMessage = (
  issue: EffectExtractionSemanticNoticeIssue,
  relatedValues: readonly string[],
  suggestedField: EffectExtractionSemanticField | null,
  raw: Record<string, unknown>,
): string => {
  const related = relatedValues[0];
  if (issue === 'POSSIBLE_DUPLICATE' && related)
    return `建议处理：与“${related}”含义接近，可保留表达更准确的一条，或合并为一条。`;
  if (issue === 'POSSIBLE_OVERLAP' && related)
    return `建议处理：与“${related}”内容重叠，可合并共同信息，或补充两者的具体差异。`;
  if (issue === 'POSSIBLE_WRONG_FIELD' && suggestedField)
    return `建议处理：可考虑将该内容移至“${SEMANTIC_FIELD_LABELS[suggestedField]}”；如需保留当前分类，请补充归类依据。`;
  if (issue === 'FIELD_OVER_RECOMMENDED_COUNT') {
    const actualCount = Number(raw.actualCount);
    const recommendedCount = Number(raw.recommendedCount);
    if (Number.isInteger(actualCount) && Number.isInteger(recommendedCount))
      return `建议精简：当前有 ${actualCount} 条，建议优先保留 ${recommendedCount} 条最重要的内容。`;
  }
  return '建议完善：请补充具体对象、使用场景或可验证特征，使表达更明确。';
};

const semanticNoticesByValue = (
  branches: readonly ExtractionOriginBranch[],
): Map<string, EffectExtractionSemanticNotice[]> => {
  const branch = branches.find(({ branch }) => branch === 'SEMANTIC_REFINEMENT');
  if (!branch?.structuredOutput || typeof branch.structuredOutput !== 'object') return new Map();
  const payload = branch.structuredOutput as Record<string, unknown>;
  const metadata =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? (payload.metadata as Record<string, unknown>)
      : {};
  const rows = Array.isArray(metadata.userFactNotices) ? metadata.userFactNotices : [];
  const notices = new Map<string, EffectExtractionSemanticNotice[]>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const raw = row as Record<string, unknown>;
    const field = String(raw.field ?? '') as EffectExtractionSemanticField;
    const issue = String(raw.issue ?? '') as EffectExtractionSemanticNoticeIssue;
    const value = safeSemanticValue(raw.value);
    const factId = String(raw.factId ?? '');
    const relatedFactIds = Array.isArray(raw.relatedFactIds) ? raw.relatedFactIds.map(String) : [];
    if (
      !SEMANTIC_NOTICE_FIELDS.has(field) ||
      !SEMANTIC_NOTICE_ISSUES.has(issue) ||
      !value ||
      !factId.startsWith(`user-${field}-`) ||
      relatedFactIds.some((id) => !id.startsWith('user-'))
    )
      continue;
    const suggestedField = SEMANTIC_NOTICE_FIELDS.has(
      String(raw.suggestedField ?? '') as EffectExtractionSemanticField,
    )
      ? (String(raw.suggestedField) as EffectExtractionSemanticField)
      : null;
    const relatedValues = (Array.isArray(raw.relatedValues) ? raw.relatedValues : [])
      .map(safeSemanticValue)
      .filter(Boolean)
      .slice(0, 3);
    const notice: EffectExtractionSemanticNotice = {
      issue,
      message: semanticNoticeMessage(issue, relatedValues, suggestedField, raw),
      suggestedField,
      relatedValues,
    };
    const key = `${field}:${normalizeOriginValue(value)}`;
    const existing = notices.get(key) ?? [];
    if (!existing.some((item) => item.issue === issue)) existing.push(notice);
    notices.set(key, existing);
  }
  return notices;
};

type ExtractionCandidateSource = {
  branch: string;
  candidate: Record<string, unknown>;
  sourceName: string;
};

const extractionCandidateSources = (
  branches: readonly ExtractionOriginBranch[],
  materials: readonly ExtractionOriginMaterial[],
): ExtractionCandidateSource[] => {
  const materialNames = new Map(
    materials.map((material) => [
      material.id,
      material.originalFileName ? safeFileName(material.originalFileName) : '用户资料',
    ]),
  );
  const fallbackName = (branch: string) =>
    ({
      FORM: '资料导入表单',
      DOCUMENT: '用户资料',
      COMMERCE: '商品链接',
      IMAGE: '产品图片',
    })[branch] ?? '提炼结果';
  const entries: ExtractionCandidateSource[] = [];
  for (const branch of branches) {
    if (
      !branch.structuredOutput ||
      typeof branch.structuredOutput !== 'object' ||
      Array.isArray(branch.structuredOutput)
    )
      continue;
    const payload = branch.structuredOutput as Record<string, unknown>;
    if (
      payload.candidate &&
      typeof payload.candidate === 'object' &&
      !Array.isArray(payload.candidate)
    ) {
      entries.push({
        branch: branch.branch,
        candidate: payload.candidate as Record<string, unknown>,
        sourceName: fallbackName(branch.branch),
      });
    }
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const item = rawItem as Record<string, unknown>;
      if (!item.candidate || typeof item.candidate !== 'object' || Array.isArray(item.candidate))
        continue;
      const candidate = item.candidate as Record<string, unknown>;
      const sourceName =
        typeof item.sourceId === 'string'
          ? (materialNames.get(item.sourceId) ?? fallbackName(branch.branch))
          : fallbackName(branch.branch);
      entries.push({ branch: branch.branch, candidate, sourceName });
    }
  }
  return entries;
};

const extractionValueProvenance = (
  result: EffectExtractionResult | null,
  branches: readonly ExtractionOriginBranch[],
  manualOverrideFields: readonly string[],
  materials: readonly ExtractionOriginMaterial[],
): EffectExtractionProvenance => {
  const provenance: EffectExtractionProvenance = {
    fieldOrigins: {},
    fieldSourceNames: {},
    itemOrigins: {},
  };
  if (!result) return provenance;

  const userCandidates = branches
    .filter(({ branch }) => ['FORM', 'DOCUMENT', 'COMMERCE'].includes(branch))
    .flatMap(({ structuredOutput }) => branchCandidates(structuredOutput));
  const imageCandidates = branches
    .filter(({ branch }) => branch === 'IMAGE')
    .flatMap(({ structuredOutput }) => branchCandidates(structuredOutput));
  const overridden = new Set(manualOverrideFields);
  const candidateSources = extractionCandidateSources(branches, materials);
  const semanticNotices = semanticNoticesByValue(branches);
  const imageSemanticValues = new Set(
    [...SEMANTIC_NOTICE_FIELDS].flatMap((semanticField) => [
      ...candidateFieldValues(imageCandidates, semanticField),
    ]),
  );

  for (const field of Object.keys(result) as (keyof EffectExtractionResult)[]) {
    const userValues = candidateFieldValues(userCandidates, field);
    const imageValues = candidateFieldValues(imageCandidates, field);
    const resolvedImageValues = SEMANTIC_NOTICE_FIELDS.has(field as EffectExtractionSemanticField)
      ? imageSemanticValues
      : imageValues;
    const originFor = (value: unknown) =>
      !overridden.has(field) &&
      !userValues.has(normalizeOriginValue(value)) &&
      resolvedImageValues.has(normalizeOriginValue(value))
        ? ('AI_IMAGE_SUGGESTION' as const)
        : ('USER_FACT' as const);
    const sourceNamesFor = (value: unknown, origin: EffectExtractionValueOrigin): string[] => {
      if (overridden.has(field)) return ['人工修改'];
      const allowedBranches =
        origin === 'AI_IMAGE_SUGGESTION'
          ? new Set(['IMAGE'])
          : new Set(['FORM', 'DOCUMENT', 'COMMERCE']);
      const names = candidateSources
        .filter((entry) => {
          if (!allowedBranches.has(entry.branch)) return false;
          if (
            origin === 'AI_IMAGE_SUGGESTION' &&
            SEMANTIC_NOTICE_FIELDS.has(field as EffectExtractionSemanticField)
          )
            return [...SEMANTIC_NOTICE_FIELDS].some((semanticField) =>
              candidateFieldValues([entry.candidate], semanticField).has(
                normalizeOriginValue(value),
              ),
            );
          return candidateFieldValues([entry.candidate], field).has(normalizeOriginValue(value));
        })
        .map((entry) => entry.sourceName);
      const uniqueNames = [...new Set(names)].slice(0, 3);
      return uniqueNames.length
        ? uniqueNames
        : [origin === 'AI_IMAGE_SUGGESTION' ? '产品图片' : '用户资料'];
    };
    const value = result[field];
    if (EXTRACTION_LIST_FIELDS.includes(field as (typeof EXTRACTION_LIST_FIELDS)[number])) {
      provenance.itemOrigins[field] = (Array.isArray(value) ? value : []).map((item) => {
        const origin = originFor(item);
        return {
          value: String(item),
          origin,
          sourceNames: sourceNamesFor(item, origin),
          ...(origin === 'USER_FACT' && !overridden.has(field)
            ? {
                semanticNotices:
                  semanticNotices.get(`${String(field)}:${normalizeOriginValue(item)}`) ?? [],
              }
            : {}),
        };
      });
    } else {
      const origin = originFor(value);
      provenance.fieldOrigins[field] = origin;
      provenance.fieldSourceNames[field] = sourceNamesFor(value, origin);
    }
  }
  return provenance;
};
