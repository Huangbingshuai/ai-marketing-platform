import type {
  EffectExtractionProductState,
  EffectExtractionResult,
  EffectExtractionRun,
  EffectVideoConfig,
  EffectVideoConfigOverride,
  GetEffectExtractionRunData,
  GetEffectExtractionWorkspaceData,
  StartEffectExtractionRunData,
  UpdateEffectExtractionResultData,
} from '@ai-marketing/contracts';
import { EFFECT_EXTRACTION_SCHEMA_VERSION, mergeEffectVideoConfig } from '@ai-marketing/contracts';
import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';

import { ApiHttpException } from '../../../common/api-http-exception';
import { ProjectService } from '../../../platform/project/project.service';
import { AssetService } from '../../../platform/asset/asset.service';
import { JOB_PROGRESS_STORE } from '../../../platform/job/job.constants';
import type { JobProgressStore } from '../../../platform/job/job.ports';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { EffectExtractionRepository } from './effect-extraction.repository';
import type { CompleteRunInput, EffectExtractionInputSnapshot } from './effect-extraction.types';
import {
  extractionSourceFingerprint,
  isSupportedExtractionMaterial,
  isEffectExtractionResult,
  parseWarnings,
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

const presentRun = (
  record: {
    id: string;
    projectId: string;
    draftId: string;
    productId: string;
    status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
    progress: number;
    currentNode: string | null;
    warnings: unknown;
    errorMessage: string | null;
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
  warnings: parseWarnings(record.warnings),
  errorMessage: record.errorMessage,
  extractResultId,
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
    @Optional() @Inject(AssetService) private readonly assets?: AssetService,
  ) {}

  private async syncCurrentResult(record: {
    id: string;
    projectId: string;
    draftId: string;
    productId: string;
    runId: string;
    revision: number;
    draftResult: unknown;
  }): Promise<void> {
    const product = await this.repository.product(record.projectId, record.productId);
    if (!this.assets || !product?.name.trim()) return;
    const productName = product.name.trim();
    await this.assets.storeWorkflowArtifact(
      record.projectId,
      'EFFECT',
      'EFFECT',
      {
        idempotencyKey: `effect-extraction:${record.draftId}:product:${record.productId}:result`,
        name: `${productName} AI 信息提炼`.slice(0, 120),
        directory: 'INSIGHTS',
        type: 'INSIGHT_RESULT',
        tags: [productName, product.category, product.sku].filter(Boolean).slice(0, 20),
        notes: '效果类当前项目 AI 信息提炼结果',
        sourceArtifactId: record.id,
        sourceRunId: record.runId,
        sourceNode: 'INFORMATION_EXTRACTION',
        contentKind: 'EFFECT_EXTRACTION_RESULT',
        businessData: { productId: product.id, productName },
        content: record.draftResult,
      },
      `current:${record.draftId}:extraction:${record.id}:r${record.revision}`,
    );
  }

  private currentFingerprint(
    draft: Awaited<ReturnType<EffectExtractionRepository['workspace']>>,
    productId: string,
  ): string {
    if (!draft) return '';
    const product = draft.products.find((item) => item.id === productId);
    if (!product) return '';
    const snapshot: EffectExtractionInputSnapshot = {
      schemaVersion: EFFECT_EXTRACTION_SCHEMA_VERSION,
      projectId: draft.projectId,
      draftId: draft.id,
      mode: draft.mode,
      sourceRevision: draft.revision,
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
    };
    return extractionSourceFingerprint(snapshot);
  }

  async cancelProjectRuns(projectId: string): Promise<{ cancelled: number }> {
    const cancelled = await this.repository.cancelProjectRuns(projectId);
    await Promise.all(
      cancelled.runIds.map((runId) =>
        this.progressStore.delete(projectId, runId).catch(() => undefined),
      ),
    );
    await Promise.all(
      cancelled.storageKeys.map((key) => this.storage.delete(key).catch(() => undefined)),
    );
    return { cancelled: cancelled.runIds.length };
  }

  async workspace(projectId: string, draftId: string): Promise<GetEffectExtractionWorkspaceData> {
    await this.projects.get(projectId);
    const draft = await this.repository.workspace(projectId, draftId);
    if (!draft) throw notFound('效果类资料草稿不存在');
    const products: EffectExtractionProductState[] = draft.products.map((product) => {
      const run = product.extractionRuns[0] ?? null;
      const result = run?.result ?? null;
      const fingerprint = this.currentFingerprint(draft, product.id);
      const stale = Boolean(result && result.sourceFingerprint !== fingerprint);
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
        resultRevision: result?.revision ?? null,
        result: (result?.draftResult as EffectExtractionResult | undefined) ?? null,
        progress: run?.progress ?? 0,
        currentNode: run?.currentNode ?? null,
        warnings: parseWarnings(run?.warnings),
        errorMessage: run?.errorMessage ?? null,
        sourceFingerprint: fingerprint,
        updatedAt: (run?.updatedAt ?? product.updatedAt).toISOString(),
      };
    });
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
    input: { draftId: string; expectedRevision: number; idempotencyKey: string },
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
    );
    if (result.kind === 'NOT_FOUND') throw notFound('资料草稿或产品不存在');
    if (result.kind === 'REVISION_CONFLICT') throw conflict('资料草稿已更新，请刷新后重试');
    if (result.kind === 'NOT_READY') throw conflict('资料导入节点尚未完成或资料不完整');
    if (result.kind === 'ACTIVE_CONFLICT') throw conflict('当前产品已有进行中的提炼任务');
    if (result.kind === 'KEY_CONFLICT') throw conflict('幂等键已用于其他提炼请求');
    const replay =
      result.kind === 'REPLAYED' ? await this.repository.run(projectId, result.run.id) : null;
    return { run: presentRun(result.run, replay?.result?.id ?? null) };
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
    const updated = await this.repository.updateResult(
      projectId,
      resultId,
      expectedRevision,
      result,
    );
    if (!updated) throw conflict('提炼结果已被其他操作更新，请刷新后重试');
    await this.syncCurrentResult(updated);
    return {
      projectId,
      productId: updated.productId,
      resultId: updated.id,
      revision: updated.revision,
      result: updated.draftResult as EffectExtractionResult,
      savedAt: updated.savedAt!.toISOString(),
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

  async storeArtifact(
    projectId: string,
    runId: string,
    attemptToken: string,
    input: { artifactKind: string; sourceId?: string | undefined; idempotencyKey: string },
    file: UploadedExtractionArtifact | undefined,
  ) {
    if (!file || file.size < 1) throw badRequest('请选择要上传的提炼产物文件');
    const fileName = safeFileName(file.originalname);
    if (
      input.artifactKind !== 'DOCLING_MARKDOWN' ||
      (!fileName.toLowerCase().endsWith('.md') &&
        !['text/markdown', 'text/plain'].includes(file.mimetype.toLowerCase()))
    )
      throw badRequest('Docling 产物必须是 Markdown 文本');
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
    let stored: { key: string; sizeBytes: number } | null = null;
    try {
      stored = await this.storage.put({
        stream: createReadStream(file.path),
        sizeBytes: file.size,
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
    if (!isEffectExtractionResult(input.result)) throw badRequest('标准化结果不符合统一结构');
    const result = await this.repository.complete(projectId, runId, attemptToken, input);
    if (result.kind === 'NOT_FOUND') throw notFound('提炼任务不存在');
    if (result.kind === 'LEASE_CONFLICT') throw conflict('Worker 租约已失效');
    await this.syncCurrentResult(result.result);
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
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
