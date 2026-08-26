import { HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';

import type { StoragePort } from '../../../platform/file/storage.port';
import type { JobProgressStore } from '../../../platform/job/job.ports';
import type { ProjectService } from '../../../platform/project/project.service';
import type { EffectExtractionRepository } from './effect-extraction.repository';
import { WorkerArtifactDto } from './dto/effect-extraction.dto';
import { EffectExtractionService } from './effect-extraction.service';

const projectService = (): ProjectService =>
  ({ get: vi.fn().mockResolvedValue({ id: 'project-a' }) }) as unknown as ProjectService;
const storage = {} as StoragePort;

const extractionResult = {
  productCategory: '食品',
  productName: '测试产品',
  coreSpecification: '100g',
  priceRange: '建议 10-20 元，需确认',
  visualFeatures: '红色包装',
  coreSellingPoints: ['卖点一'],
  secondarySellingPoints: [],
  trustBackings: [],
  targetAudience: '家庭用户',
  corePainPoints: ['备餐麻烦'],
  decisionDrivers: ['包装便利'],
  marketingGoal: '促进转化',
  usageScenarios: ['家庭聚餐'],
  purchaseScenarios: ['日常囤货'],
  emotionalScenarios: ['家庭分享'],
  durationSeconds: 15,
  aspectRatio: '9:16',
  resolution: '1080p',
  deliveryChannels: '抖音',
  disabledElements: ['系统禁用词'],
  visualStyleBaseline: '烟火食欲感',
};

const runRecord = {
  id: 'run-a',
  projectId: 'project-a',
  draftId: 'draft-a',
  productId: 'product-a',
  status: 'RUNNING' as const,
  progress: 20,
  currentNode: 'DOCUMENT',
  warnings: [],
  errorMessage: null,
  createdAt: new Date('2026-08-21T00:00:00.000Z'),
  updatedAt: new Date('2026-08-21T00:01:00.000Z'),
  result: null,
  branches: [
    {
      branch: 'DOCUMENT' as const,
      status: 'SUCCEEDED' as const,
      warnings: [],
      errorMessage: null,
    },
    {
      branch: 'IMAGE' as const,
      status: 'RUNNING' as const,
      warnings: [],
      errorMessage: null,
    },
  ],
};

describe('EffectExtractionService', () => {
  it('loads node details through the project-scoped run lookup', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        inputSnapshot: {
          schemaVersion: 1,
          projectId: 'project-a',
          draftId: 'draft-a',
          mode: 'SINGLE',
          sourceRevision: 1,
          product: {
            id: 'product-a',
            name: '测试产品',
            category: '测试品类',
            sku: '',
            commerceUrl: null,
            effectiveConfig: {
              aspectRatio: '9:16',
              durationSeconds: 15,
              resolution: '1080P',
              frameRate: 30,
              subtitleStrategy: '跟随口播',
              voiceoverStrategy: 'AI 女声',
              bgmStrategy: '自动匹配',
              styleTone: '清爽明亮',
              deliveryChannel: '抖音',
              disabledElements: [],
            },
          },
          materials: [],
        },
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storage,
    );

    const result = await service.nodeDetail('project-a', 'run-a', 'LOAD_AND_SNAPSHOT');

    expect(repository.run).toHaveBeenCalledWith('project-a', 'run-a');
    expect(result.detail).toMatchObject({
      nodeId: 'LOAD_AND_SNAPSHOT',
      status: 'SUCCEEDED',
    });
  });

  it('keeps run lookup project-scoped and falls back to database progress when Redis fails', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({ ...runRecord }),
    } as unknown as EffectExtractionRepository;
    const progress = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as JobProgressStore;
    const service = new EffectExtractionService(repository, projectService(), progress, storage);

    const result = await service.run('project-a', 'run-a');

    expect(repository.run).toHaveBeenCalledWith('project-a', 'run-a');
    expect(result.run.progress).toBe(20);
    expect(result.run.currentNode).toBe('DOCUMENT');
    expect(result.run.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'LOAD_AND_SNAPSHOT', status: 'SUCCEEDED' }),
        expect.objectContaining({ nodeId: 'DOCUMENT', status: 'SUCCEEDED' }),
        expect.objectContaining({ nodeId: 'IMAGE', status: 'RUNNING' }),
        expect.objectContaining({ nodeId: 'FUSION', status: 'PENDING' }),
      ]),
    );
  });

  it('maps an unfinished branch to failed without exposing its structured output', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        status: 'FAILED',
        errorMessage: '模型响应不符合结构',
        branches: [
          {
            branch: 'NORMALIZATION',
            status: 'RUNNING',
            warnings: [],
            errorMessage: null,
            structuredOutput: { secret: 'must-not-leak' },
            textStorageKey: 'private/markdown.md',
          },
        ],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');

    expect(result.run.nodes.find((node) => node.nodeId === 'NORMALIZATION')).toMatchObject({
      status: 'FAILED',
      errorMessage: '模型响应不符合结构',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('private/markdown.md');
  });

  it('keeps the snapshot running after claim until a persisted branch starts', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        currentNode: null,
        branches: [],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');

    expect(result.run.nodes[0]).toMatchObject({
      nodeId: 'LOAD_AND_SNAPSHOT',
      status: 'RUNNING',
    });
  });

  it('preserves partial, skipped and failed branch states and their public warnings', async () => {
    const warning = {
      code: 'SOURCE_WARNING',
      message: '部分文档无法解析',
      branch: 'DOCUMENT' as const,
      sourceId: 'material-a',
      structuredOutput: { prompt: 'must-not-leak' },
      textStorageKey: 'private/source.md',
    };
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        branches: [
          {
            branch: 'DOCUMENT',
            status: 'PARTIAL',
            warnings: [warning],
            errorMessage: null,
          },
          {
            branch: 'COMMERCE',
            status: 'SKIPPED',
            warnings: [],
            errorMessage: null,
          },
          {
            branch: 'FORM',
            status: 'FAILED',
            warnings: [],
            errorMessage: '表单缺少产品名称或品类',
          },
        ],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');

    expect(result.run.nodes.find((node) => node.nodeId === 'DOCUMENT')).toMatchObject({
      status: 'PARTIAL',
      warnings: [
        {
          code: 'SOURCE_WARNING',
          message: '部分文档无法解析',
          branch: 'DOCUMENT',
          sourceId: 'material-a',
        },
      ],
    });
    expect(result.run.nodes.find((node) => node.nodeId === 'COMMERCE')).toMatchObject({
      status: 'SKIPPED',
    });
    expect(result.run.nodes.find((node) => node.nodeId === 'FORM')).toMatchObject({
      status: 'FAILED',
      errorMessage: '表单缺少产品名称或品类',
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('private/source.md');
  });

  it('shows a document timeout once and removes duplicate branch warnings', async () => {
    const timeoutWarning = {
      code: 'SOURCE_WARNING',
      message: '文档 AI 抽取超时',
      branch: 'DOCUMENT' as const,
      sourceId: null,
    };
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        branches: [
          {
            branch: 'DOCUMENT',
            status: 'FAILED',
            warnings: [timeoutWarning, timeoutWarning],
            errorMessage: '文档 AI 抽取超时',
          },
        ],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');
    const document = result.run.nodes.find((node) => node.nodeId === 'DOCUMENT');

    expect(document).toMatchObject({
      status: 'FAILED',
      errorMessage: '文档 AI 抽取超时',
      warnings: [],
    });
    expect(JSON.stringify(document).match(/文档 AI 抽取超时/gu)).toHaveLength(1);
  });

  it('recognizes a legacy generic document error as timeout from its safe duration', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        branches: [
          {
            branch: 'DOCUMENT',
            status: 'FAILED',
            warnings: [
              {
                code: 'SOURCE_WARNING',
                message: 'Ark structured-output request failed',
                branch: 'DOCUMENT',
                sourceId: null,
              },
            ],
            errorCode: 'DOCUMENT_FAILED',
            errorMessage: 'Ark structured-output request failed',
            startedAt: new Date('2026-08-24T09:06:39.000Z'),
            completedAt: new Date('2026-08-24T09:12:41.000Z'),
          },
        ],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');
    const document = result.run.nodes.find((node) => node.nodeId === 'DOCUMENT');

    expect(document).toMatchObject({
      status: 'FAILED',
      errorMessage: '文档 AI 抽取超时',
    });
    expect(document?.warnings).toEqual([]);
    expect(JSON.stringify(document).match(/文档 AI 抽取超时/gu)).toHaveLength(1);
    expect(JSON.stringify(document)).not.toContain('Ark structured-output request failed');
  });

  it('presents legacy form-completeness warnings as a successful global-config node', async () => {
    const retiredWarning = {
      code: 'SOURCE_WARNING',
      message: '表单尚未填写品类，将由其他资料补充',
      branch: 'FORM' as const,
      sourceId: null,
    };
    const repository = {
      run: vi.fn().mockResolvedValue({
        ...runRecord,
        status: 'COMPLETED',
        progress: 100,
        warnings: [retiredWarning],
        branches: [
          {
            branch: 'FORM',
            status: 'PARTIAL',
            warnings: [retiredWarning],
            errorMessage: null,
          },
          {
            branch: 'FUSION',
            status: 'SUCCEEDED',
            warnings: [{ ...retiredWarning, branch: 'FUSION' }],
            errorMessage: null,
          },
        ],
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      { get: vi.fn().mockResolvedValue(null) } as unknown as JobProgressStore,
      storage,
    );

    const result = await service.run('project-a', 'run-a');

    expect(result.run.warnings).toEqual([]);
    expect(result.run.nodes.find((node) => node.nodeId === 'FORM')).toMatchObject({
      status: 'SUCCEEDED',
      warnings: [],
    });
    expect(result.run.nodes.find((node) => node.nodeId === 'FUSION')).toMatchObject({
      status: 'SUCCEEDED',
      warnings: [],
    });
  });

  it('uses newer Redis progress without allowing it to lower database progress', async () => {
    const repository = {
      run: vi.fn().mockResolvedValue({ ...runRecord }),
    } as unknown as EffectExtractionRepository;
    const progress = {
      get: vi.fn().mockResolvedValue({ progress: 65, currentNode: 'FUSION' }),
    } as unknown as JobProgressStore;
    const service = new EffectExtractionService(repository, projectService(), progress, storage);

    const result = await service.run('project-a', 'run-a');

    expect(result.run.progress).toBe(65);
    expect(result.run.currentNode).toBe('FUSION');
  });

  it('rejects malformed manual result updates before touching persistence', async () => {
    const repository = {
      result: vi.fn(),
      updateResult: vi.fn(),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storage,
    );

    await expect(
      service.updateResult('project-a', 'result-a', 1, { productName: 'only one field' }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(repository.result).not.toHaveBeenCalled();
  });

  it('keeps user-selected production rules as field-level overrides', async () => {
    const config = {
      aspectRatio: '9:16',
      durationSeconds: 15,
      resolution: '1080P',
      frameRate: 30,
      subtitleStrategy: '跟随口播',
      voiceoverStrategy: 'AI 女声',
      bgmStrategy: '自动匹配',
      styleTone: '烟火食欲感',
      deliveryChannel: '抖音',
      disabledElements: ['系统禁用词'],
    };
    const editedResult = {
      ...extractionResult,
      durationSeconds: 40,
      aspectRatio: '3:4',
      deliveryChannels: '快手',
      visualStyleBaseline: '国潮新中式',
      disabledElements: ['人工禁用词'],
    };
    const repository = {
      result: vi.fn().mockResolvedValue({
        id: 'result-a',
        runId: 'run-a',
        generatedResult: extractionResult,
      }),
      run: vi.fn().mockResolvedValue({
        inputSnapshot: {
          globalVideoConfig: config,
          product: { effectiveConfig: config },
        },
      }),
      updateResult: vi.fn().mockResolvedValue({
        id: 'result-a',
        runId: 'run-a',
        productId: 'product-a',
        revision: 2,
        draftResult: {
          ...editedResult,
          disabledElements: ['系统禁用词', '人工禁用词'],
        },
        savedAt: new Date('2026-08-25T08:00:00.000Z'),
      }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storage,
    );

    const result = await service.updateResult('project-a', 'result-a', 1, editedResult);

    expect(repository.updateResult).toHaveBeenCalledWith(
      'project-a',
      'result-a',
      1,
      { ...editedResult, disabledElements: ['系统禁用词', '人工禁用词'] },
      expect.objectContaining({
        durationSeconds: 40,
        aspectRatio: '3:4',
        deliveryChannels: '快手',
        visualStyleBaseline: '国潮新中式',
      }),
    );
    expect(result.result).toMatchObject({
      durationSeconds: 40,
      aspectRatio: '3:4',
      deliveryChannels: '快手',
      visualStyleBaseline: '国潮新中式',
    });
  });

  it('maps a stale revision to a conflict and does not create a response run', async () => {
    const repository = {
      startRun: vi.fn().mockResolvedValue({ kind: 'REVISION_CONFLICT' }),
    } as unknown as EffectExtractionRepository;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storage,
    );

    await expect(
      service.start('project-a', 'product-a', {
        draftId: 'draft-a',
        expectedRevision: 3,
        idempotencyKey: 'click-a',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
  });

  it('does not fail a heartbeat when Redis progress caching is unavailable', async () => {
    const repository = {
      progress: vi.fn().mockResolvedValue(true),
    } as unknown as EffectExtractionRepository;
    const progress = {
      set: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as JobProgressStore;
    const service = new EffectExtractionService(repository, projectService(), progress, storage);

    await expect(service.progress('project-a', 'run-a', 'attempt-a', 45, 'IMAGE')).resolves.toEqual(
      { accepted: true },
    );
  });

  it('replays an artifact upload idempotently without writing object storage again', async () => {
    const repository = {
      authorizedRun: vi.fn().mockResolvedValue({ inputSnapshot: {}, productId: 'product-a' }),
      artifactByKey: vi.fn().mockResolvedValue({
        id: 'artifact-a',
        artifactKind: 'DOCLING_MARKDOWN',
        sourceId: 'material-a',
        storageKey: 'stored/doc.md',
        sizeBytes: 42,
      }),
    } as unknown as EffectExtractionRepository;
    const storagePort = { put: vi.fn(), delete: vi.fn() } as unknown as StoragePort;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storagePort,
    );

    await expect(
      service.storeArtifact(
        'project-a',
        'run-a',
        'attempt-a',
        {
          artifactKind: 'DOCLING_MARKDOWN',
          sourceId: 'material-a',
          idempotencyKey: 'docling:material-a',
        },
        {
          path: 'Z:/missing-but-force-removable.md',
          originalname: 'result.md',
          mimetype: 'text/markdown',
          size: 42,
        },
      ),
    ).resolves.toEqual({
      artifactId: 'artifact-a',
      storageKey: 'stored/doc.md',
      sizeBytes: 42,
      replayed: true,
    });
    expect(storagePort.put).not.toHaveBeenCalled();
  });

  it('accepts COMMERCE_MARKDOWN in the worker artifact DTO', async () => {
    const dto = plainToInstance(WorkerArtifactDto, {
      projectId: '2f67a1e4-3ccd-4505-a0aa-0a868d3439c0',
      artifactKind: 'COMMERCE_MARKDOWN',
      idempotencyKey: 'commerce:product-a',
    });

    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('rejects raw HTML and unknown worker artifact kinds', async () => {
    const dto = plainToInstance(WorkerArtifactDto, {
      projectId: '2f67a1e4-3ccd-4505-a0aa-0a868d3439c0',
      artifactKind: 'COMMERCE_RAW_HTML',
      idempotencyKey: 'commerce:product-a',
    });

    const errors = await validate(dto);
    expect(errors).toEqual([
      expect.objectContaining({
        property: 'artifactKind',
        constraints: expect.objectContaining({ isIn: expect.any(String) }),
      }),
    ]);
  });

  it('replays a project-scoped commerce artifact idempotently', async () => {
    const repository = {
      authorizedRun: vi.fn().mockResolvedValue({ inputSnapshot: {}, productId: 'product-a' }),
      artifactByKey: vi.fn().mockResolvedValue({
        id: 'artifact-commerce',
        artifactKind: 'COMMERCE_MARKDOWN',
        sourceId: null,
        storageKey: 'stored/commerce.md',
        sizeBytes: 128,
      }),
    } as unknown as EffectExtractionRepository;
    const storagePort = { put: vi.fn(), delete: vi.fn() } as unknown as StoragePort;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storagePort,
    );

    await expect(
      service.storeArtifact(
        'project-a',
        'run-a',
        'attempt-a',
        {
          artifactKind: 'COMMERCE_MARKDOWN',
          idempotencyKey: 'commerce:product-a',
        },
        {
          path: 'Z:/missing-but-force-removable.md',
          originalname: 'commerce.md',
          mimetype: 'text/plain',
          size: 128,
        },
      ),
    ).resolves.toEqual({
      artifactId: 'artifact-commerce',
      storageKey: 'stored/commerce.md',
      sizeBytes: 128,
      replayed: true,
    });
    expect(repository.authorizedRun).toHaveBeenCalledWith('project-a', 'run-a', 'attempt-a');
    expect(repository.artifactByKey).toHaveBeenCalledWith(
      'project-a',
      'run-a',
      'commerce:product-a',
    );
    expect(storagePort.put).not.toHaveBeenCalled();
  });

  it('rejects non-text commerce artifacts before storage', async () => {
    const repository = {
      authorizedRun: vi.fn(),
      artifactByKey: vi.fn(),
    } as unknown as EffectExtractionRepository;
    const storagePort = { put: vi.fn(), delete: vi.fn() } as unknown as StoragePort;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storagePort,
    );

    await expect(
      service.storeArtifact(
        'project-a',
        'run-a',
        'attempt-a',
        {
          artifactKind: 'COMMERCE_MARKDOWN',
          idempotencyKey: 'commerce:product-a',
        },
        {
          path: 'Z:/missing-commerce.bin',
          originalname: 'commerce.bin',
          mimetype: 'application/octet-stream',
          size: 128,
        },
      ),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
    expect(repository.authorizedRun).not.toHaveBeenCalled();
    expect(storagePort.put).not.toHaveBeenCalled();
  });

  it('does not access storage when the commerce artifact lease is outside the project scope', async () => {
    const repository = {
      authorizedRun: vi.fn().mockResolvedValue(null),
      artifactByKey: vi.fn(),
    } as unknown as EffectExtractionRepository;
    const storagePort = { put: vi.fn(), delete: vi.fn() } as unknown as StoragePort;
    const service = new EffectExtractionService(
      repository,
      projectService(),
      {} as JobProgressStore,
      storagePort,
    );

    await expect(
      service.storeArtifact(
        'project-b',
        'run-a',
        'attempt-a',
        {
          artifactKind: 'COMMERCE_MARKDOWN',
          idempotencyKey: 'commerce:product-a',
        },
        {
          path: 'Z:/missing-commerce.md',
          originalname: 'commerce.md',
          mimetype: 'text/markdown',
          size: 128,
        },
      ),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    expect(repository.authorizedRun).toHaveBeenCalledWith('project-b', 'run-a', 'attempt-a');
    expect(repository.artifactByKey).not.toHaveBeenCalled();
    expect(storagePort.put).not.toHaveBeenCalled();
  });
});
