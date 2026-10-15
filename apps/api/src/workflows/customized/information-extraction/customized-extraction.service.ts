import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  CUSTOMIZED_EXTRACTION_NODES,
  CUSTOMIZED_BRIEF_LABELS,
  isCustomizedBrief,
  normalizeCustomizedBrief,
  type CustomizedBriefCandidate,
  type CustomizedExtractionWorkspace,
  type ExtractionNodeDetail,
  type SaveCustomizedExtractionRequest,
  type StartCustomizedExtractionRequest,
} from '@ai-marketing/contracts';
import { ProjectService } from '../../../platform/project/project.service';
import { STORAGE_PORT, type StoragePort } from '../../../platform/file/storage.port';
import { ApiHttpException } from '../../../common/api-http-exception';
import {
  CustomizedExtractionRepository,
  presentTask,
  type ExtractionInput,
} from './customized-extraction.repository';
import { EffectReadCacheService } from '../../../platform/cache/effect-read-cache.service';
import {
  parsedDocumentExcerpt,
  presentCustomizedNodeDetail,
  type ParsedDocumentPreview,
} from './customized-extraction-node-detail';

function invalid(message: string): never {
  throw new ApiHttpException(message, 400, 'VALIDATION_ERROR');
}
@Injectable()
export class CustomizedExtractionService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private recovering = false;
  private readonly logger = new Logger(CustomizedExtractionService.name);
  constructor(
    @Inject(CustomizedExtractionRepository)
    private readonly repository: CustomizedExtractionRepository,
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(EffectReadCacheService) private readonly cache: EffectReadCacheService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      if (this.recovering) return;
      this.recovering = true;
      void this.repository
        .recoverExpired()
        .catch(() => this.logger.warn('定制类提炼租约恢复暂未完成，将在下一轮重试'))
        .finally(() => {
          this.recovering = false;
        });
    }, 30000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async workspace(
    projectId: string,
    workflowRunId: string,
  ): Promise<CustomizedExtractionWorkspace> {
    await this.projects.get(projectId);
    return this.cache.read(
      { projectId, workflow: 'CUSTOMIZED', workflowRunId },
      'customized-extraction',
      () => this.repository.workspace(projectId, workflowRunId),
      // Retire projections that derived draft freshness from the old confirmed artifact.
      { projectionVersion: 3 },
    );
  }
  async start(projectId: string, body: StartCustomizedExtractionRequest) {
    await this.projects.get(projectId);
    return { task: await this.repository.start(projectId, body) };
  }
  async task(projectId: string, taskId: string) {
    await this.projects.get(projectId);
    return { task: presentTask(await this.repository.task(projectId, taskId)) };
  }
  async retry(projectId: string, taskId: string) {
    await this.projects.get(projectId);
    return { task: await this.repository.retry(projectId, taskId) };
  }
  async edit(projectId: string, runId: string, cancel = false) {
    await this.projects.get(projectId);
    const run = await (cancel
      ? this.repository.cancelEdit(projectId, runId)
      : this.repository.beginEdit(projectId, runId));
    return { workflowRunId: run.id };
  }
  async update(projectId: string, resultId: string, request: SaveCustomizedExtractionRequest) {
    await this.projects.get(projectId);
    if (!isCustomizedBrief(request.fields)) invalid('信息卡格式无效');
    return this.repository.update(projectId, resultId, {
      ...request,
      fields: normalizeCustomizedBrief(request.fields),
    });
  }
  async confirm(projectId: string, resultId: string, expectedRevision: number) {
    await this.projects.get(projectId);
    return this.repository.confirm(projectId, resultId, expectedRevision);
  }
  async nodeDetail(
    projectId: string,
    taskId: string,
    nodeId: string,
  ): Promise<ExtractionNodeDetail> {
    await this.projects.get(projectId);
    const node = CUSTOMIZED_EXTRACTION_NODES.find((n) => n.id === nodeId);
    if (!node) invalid('执行节点不存在');
    const record = await this.repository.task(projectId, taskId);
    const execution = presentTask(record).nodes.find((n) => n.nodeId === nodeId)!;
    const input = record.inputSnapshot as unknown as ExtractionInput;
    const previews = new Map<string, ParsedDocumentPreview>();
    if (nodeId === 'DOCUMENT_PARSE') {
      // Read only frozen successful parse artifacts, two at a time and at most 64 KiB each.
      const documents = input.documents.filter((d) =>
        record.steps.some(
          (s) => s.nodeId === nodeId && s.sourceId === d.assetId && s.status === 'SUCCEEDED',
        ),
      );
      for (let index = 0; index < documents.length; index += 2) {
        await Promise.all(
          documents.slice(index, index + 2).map(async (doc) => {
            try {
              const artifact = await this.repository.findArtifact(projectId, taskId, doc.assetId);
              if (!artifact) {
                previews.set(doc.assetId, null);
                return;
              }
              if (artifact.sizeBytes === 0) {
                previews.set(doc.assetId, { sizeBytes: 0, text: '' });
                return;
              }
              const opened = await this.storage.open(artifact.storageKey, {
                start: 0,
                end: Math.min(artifact.sizeBytes, 65536) - 1,
              });
              const chunks: Buffer[] = [];
              try {
                let read = 0;
                for await (const chunk of opened.stream) {
                  const buffer = Buffer.from(chunk);
                  chunks.push(buffer.subarray(0, 65536 - read));
                  read += buffer.length;
                  if (read >= 65536) break;
                }
              } finally {
                opened.stream.destroy();
              }
              previews.set(doc.assetId, {
                sizeBytes: artifact.sizeBytes,
                text: parsedDocumentExcerpt(Buffer.concat(chunks).toString('utf8')),
              });
            } catch {
              previews.set(doc.assetId, null);
            }
          }),
        );
      }
    }
    return presentCustomizedNodeDetail(record, execution, previews);
  }
  claim(projectId: string, taskId: string) {
    return this.repository.claim(projectId, taskId);
  }
  progress(projectId: string, taskId: string, token: string, progress: number, nodeId: string) {
    return this.repository.progress(projectId, taskId, token, progress, nodeId);
  }
  step(
    projectId: string,
    taskId: string,
    token: string,
    nodeId: string,
    sourceId: string,
    status: string,
    output: unknown,
    errorMessage?: string,
  ) {
    return this.repository.step(
      projectId,
      taskId,
      token,
      nodeId,
      sourceId,
      status,
      output,
      errorMessage ? '该步骤处理失败，请重试或检查简报内容' : null,
    );
  }
  fail(projectId: string, taskId: string, token: string, partial: boolean) {
    return this.repository.fail(
      projectId,
      taskId,
      token,
      partial,
      partial ? '部分简报未完成处理，请重试失败文档' : '提炼未完成，请检查资料或服务配置后重试',
    );
  }
  async complete(
    projectId: string,
    taskId: string,
    token: string,
    candidate: CustomizedBriefCandidate,
  ) {
    if (
      !candidate ||
      !isCustomizedBrief(candidate.fields) ||
      !Array.isArray(candidate.issues) ||
      !candidate.fieldSources ||
      typeof candidate.fieldSources !== 'object' ||
      Array.isArray(candidate.fieldSources)
    )
      invalid('提炼结果结构无效');
    const task = await this.repository.completionAccess(projectId, taskId, token);
    const input = task.inputSnapshot as unknown as ExtractionInput;
    for (const [key, sources] of Object.entries(candidate.fieldSources)) {
      if (
        !(key in CUSTOMIZED_BRIEF_LABELS) ||
        !Array.isArray(sources) ||
        sources.some(
          (s) =>
            !s ||
            typeof s !== 'object' ||
            !input.documents.some(
              (d) => d.assetId === s.assetId && d.assetVersion === s.assetVersion,
            ) ||
            typeof s.location !== 'string' ||
            !s.location.trim() ||
            s.location.length > 1000,
        )
      )
        invalid('提炼来源映射无效');
    }
    const issueIds = new Set<string>();
    for (const issue of candidate.issues) {
      if (
        !issue ||
        typeof issue.id !== 'string' ||
        !issue.id.trim() ||
        issueIds.has(issue.id) ||
        issue.id.length > 200 ||
        !(issue.field in CUSTOMIZED_BRIEF_LABELS) ||
        issue.field === ('sellingPoints' as string) ||
        typeof issue.message !== 'string' ||
        issue.message.length > 1000 ||
        typeof issue.blocking !== 'boolean' ||
        !Array.isArray(issue.alternatives) ||
        issue.alternatives.some((v) => typeof v !== 'string' || v.length > 50000) ||
        !Array.isArray(issue.sourceIds) ||
        issue.sourceIds.some((id) => !input.documents.some((d) => d.assetId === id))
      )
        invalid('资料差异结构无效');
      issueIds.add(issue.id);
    }
    const fields = normalizeCustomizedBrief(candidate.fields);
    for (const [key, value] of Object.entries(fields))
      if (
        (Array.isArray(value) ? value.length : value.trim().length) &&
        !candidate.fieldSources[key as keyof typeof fields]?.length
      )
        invalid('提炼内容缺少资料来源');
    if (
      candidate.fieldSources.sellingPoints?.some(
        (s) =>
          s.itemIndex == null ||
          !Number.isInteger(s.itemIndex) ||
          s.itemIndex < 0 ||
          s.itemIndex >= fields.sellingPoints.length,
      ) ||
      fields.sellingPoints.some(
        (_point, index) =>
          !candidate.fieldSources.sellingPoints?.some((s) => s.itemIndex === index),
      )
    )
      invalid('卖点来源索引无效');
    return this.repository.complete(projectId, taskId, token, { ...candidate, fields });
  }
  async content(
    projectId: string,
    taskId: string,
    token: string,
    sourceId: string,
    parsed = false,
  ) {
    const task = await this.repository.access(projectId, taskId, token);
    const source = (task.inputSnapshot as unknown as ExtractionInput).documents.find(
      (d) => d.assetId === sourceId,
    );
    if (!source) invalid('文件不属于本次提炼');
    const artifact = parsed
      ? await this.repository.findArtifact(projectId, taskId, sourceId)
      : null;
    if (parsed && !artifact) invalid('解析结果尚未保存');
    return this.storage.open(artifact?.storageKey ?? source.storageKey);
  }
  async artifact(
    projectId: string,
    taskId: string,
    token: string,
    sourceId: string,
    file?: { path: string; size: number },
  ) {
    let storedKey: string | null = null;
    try {
      if (!file || file.size < 1 || file.size > 20 * 1024 * 1024) invalid('解析文档大小无效');
      await this.repository.access(projectId, taskId, token);
      const existing = await this.repository.findArtifact(projectId, taskId, sourceId);
      if (existing) return { artifactId: existing.id };
      const project = await this.projects.get(projectId);
      const stored = await this.storage.put({
        projectId,
        stream: createReadStream(file.path),
        sizeBytes: file.size,
        contentType: 'text/plain; charset=utf-8',
        keyContext: {
          projectName: project.name,
          workflow: 'CUSTOMIZED',
          lifecycle: 'staging',
          category: 'extraction',
          originalFileName: `${taskId}-${sourceId}.txt`,
        },
      });
      storedKey = stored.key;
      const result = await this.repository.artifact(
        projectId,
        taskId,
        token,
        sourceId,
        stored.key,
        stored.sizeBytes,
      );
      if (result.storageKey !== stored.key) await this.storage.delete(stored.key);
      storedKey = null;
      return { artifactId: result.id };
    } finally {
      if (file) await rm(file.path, { force: true }).catch(() => undefined);
      if (storedKey) await this.storage.delete(storedKey).catch(() => undefined);
    }
  }
}
