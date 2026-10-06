import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectSegmentImportService } from './effect-segment-import.service';
import { inspectImportVideo } from './effect-segment-import-media';
import { DuplicateSegmentImportError } from './effect-segment-import-duplicate';
import { EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES } from '@ai-marketing/contracts';
import { ImportCompleteDto } from './effect-segment-import.controller';
import { validate } from 'class-validator';
vi.mock('./effect-segment-import-media', () => ({ inspectImportVideo: vi.fn() }));
const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true }));
  vi.clearAllMocks();
});
const draft = (overrides = {}) => ({
  id: 'draft',
  projectId: 'project',
  workflowRunId: 'run',
  batchId: 'batch',
  status: 'READY',
  descriptionStatus: 'IDLE',
  promptText: '',
  primaryPurpose: null,
  compatiblePurposes: [],
  durationSeconds: 10,
  width: 720,
  height: 1280,
  frameRate: 30,
  fileName: 'clip.mp4',
  sizeBytes: 5,
  errorMessage: null,
  storageKey: 'staged/file',
  expiresAt: new Date(Date.now() + 10000),
  ...overrides,
});
function fixture() {
  const drafts = {
    find: vi.fn().mockResolvedValue(draft()),
    checkUpload: vi.fn().mockResolvedValue(null),
    stage: vi.fn().mockImplementation(async (data) => ({
      draft: draft(data),
      replayed: false,
    })),
    describe: vi.fn().mockResolvedValue(draft({ descriptionStatus: 'QUEUED' })),
    cancel: vi.fn().mockResolvedValue({ count: 1 }),
    claim: vi.fn(),
    finish: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const renders = { appendImportedMaterials: vi.fn().mockResolvedValue('UPDATED') };
  const context = {
    project: { name: '测试' },
    batch: { workflowRunId: 'run', productId: 'product', product: { name: '测试' } },
  };
  const render = {
    importContext: vi.fn().mockResolvedValue(context),
    batch: vi.fn().mockResolvedValue({ batch: { revision: 2 } }),
  };
  const storage = {
    put: vi.fn().mockImplementation(async (input) => {
      for await (const _chunk of input.stream) {
        void _chunk;
        /* Consume the upload, as the real storage adapter does. */
      }
      return { key: 'staged/file', sizeBytes: 5 };
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    open: vi.fn(),
  };
  const service = new EffectSegmentImportService(
    drafts as never,
    renders as never,
    render as never,
    storage as never,
  );
  const temporary = mkdtempSync(join(tmpdir(), 'segment-import-test-'));
  directories.push(temporary);
  const path = join(temporary, 'clip.mp4');
  writeFileSync(path, 'video');
  const upload = {
    path,
    fieldname: 'files',
    originalname: 'clip.mp4',
    mimetype: 'text/plain',
    size: 5,
  };
  vi.mocked(inspectImportVideo).mockResolvedValue({
    durationSeconds: 10,
    width: 720,
    height: 1280,
    frameRate: 30,
    mimeType: 'video/mp4',
  });
  return { service, drafts, renders, render, storage, upload };
}
describe('independent import drafts', () => {
  it.each(['PENDING', 'IMPORTED'] as const)(
    'rejects identical content in %s before storage or task creation',
    async (kind) => {
      const { service, drafts, storage, renders, upload } = fixture();
      drafts.checkUpload.mockRejectedValue(new DuplicateSegmentImportError(kind, 'R-021'));
      await expect(
        service.stage('project', 'batch', 'new-key', { ...upload, originalname: '改名.mp4' }),
      ).rejects.toThrow('重复');
      expect(drafts.checkUpload).toHaveBeenCalledWith(
        'project',
        'batch',
        'new-key',
        expect.stringMatching(/^[a-f0-9]{64}$/u),
      );
      expect(storage.put).not.toHaveBeenCalled();
      expect(drafts.stage).not.toHaveBeenCalled();
      expect(renders.appendImportedMaterials).not.toHaveBeenCalled();
    },
  );
  it('cleans only the losing upload if a concurrent duplicate appears after preflight', async () => {
    const { service, drafts, storage, upload } = fixture();
    drafts.stage.mockRejectedValue(new DuplicateSegmentImportError('PENDING'));
    await expect(service.stage('project', 'batch', 'key', upload)).rejects.toThrow('重复');
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith('staged/file');
  });
  it('replays the original key without reuploading, but rejects key reuse for another file', async () => {
    const { createHash } = await import('node:crypto');
    const { service, drafts, storage, upload } = fixture();
    drafts.checkUpload.mockResolvedValue(
      draft({ sha256: createHash('sha256').update('video').digest('hex') }),
    );
    expect((await service.stage('project', 'batch', 'key', upload)).replayed).toBe(true);
    drafts.checkUpload.mockResolvedValue(draft({ sha256: 'a'.repeat(64) }));
    await expect(service.stage('project', 'batch', 'key', upload)).rejects.toThrow('幂等键');
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('presents a safe conflict when confirmation detects old duplicate drafts', async () => {
    const { service, renders, render } = fixture();
    renders.appendImportedMaterials.mockResolvedValue('DUPLICATE_CONTENT');
    await expect(
      service.confirm(
        'project',
        'batch',
        [
          {
            draftId: 'draft',
            promptText: '描述',
            primaryPurpose: 'HOOK',
            compatiblePurposes: ['HOOK'],
          },
        ],
        1,
        'key',
      ),
    ).rejects.toThrow('重复');
    expect(render.batch).not.toHaveBeenCalled();
  });
  it('rejects confirmations exceeding the five-video batch limit before insertion', async () => {
    const { service, renders } = fixture();
    await expect(
      service.confirm(
        'project',
        'batch',
        Array.from({ length: 6 }, (_, i) => ({
          draftId: `draft-${i}`,
          promptText: '视频描述',
          primaryPurpose: 'HOOK' as const,
          compatiblePurposes: ['HOOK' as const],
        })),
        1,
        'key',
      ),
    ).rejects.toThrow('列表无效');
    expect(renders.appendImportedMaterials).not.toHaveBeenCalled();
  });
  it('stages validated media without creating tasks, ignoring untrusted MIME', async () => {
    const { service, drafts, renders, storage, upload } = fixture();
    const result = await service.stage('project', 'batch', 'key', upload);
    expect(result.draft.status).toBe('READY');
    expect(result.draft).toMatchObject({ width: 720, height: 1280, frameRate: 30 });
    expect(drafts.stage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'video/mp4', durationSeconds: 10 }),
    );
    expect(renders.appendImportedMaterials).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });
  it('retains actual metadata in polling responses, including unknown legacy frame rates', async () => {
    const { service, drafts } = fixture();
    expect((await service.get('project', 'batch', 'draft')).draft).toMatchObject({
      width: 720,
      height: 1280,
      frameRate: 30,
    });
    drafts.find.mockResolvedValue(draft({ frameRate: null }));
    expect((await service.get('project', 'batch', 'draft')).draft.frameRate).toBeNull();
  });
  it('invalid media never reaches object storage', async () => {
    const { service, storage, upload } = fixture();
    vi.mocked(inspectImportVideo).mockRejectedValue(new Error('导入视频时长必须在 4～30 秒之间'));
    await expect(service.stage('project', 'batch', 'key', upload)).rejects.toThrow('4～30');
    expect(storage.put).not.toHaveBeenCalled();
  });
  it('cleans uploaded orphans after persistence fails', async () => {
    const { service, drafts, storage, upload } = fixture();
    drafts.stage.mockRejectedValue(new Error('database unavailable'));
    await expect(service.stage('project', 'batch', 'key', upload)).rejects.toThrow();
    expect(storage.delete).toHaveBeenCalledWith('staged/file');
  });
  it('requires nonempty editable prompt and creates materials only on confirmation', async () => {
    const { service, renders } = fixture();
    await expect(
      service.confirm(
        'project',
        'batch',
        [
          {
            draftId: 'draft',
            promptText: ' ',
            primaryPurpose: 'EFFECT',
            compatiblePurposes: ['EFFECT'],
          },
        ],
        1,
        'key',
      ),
    ).rejects.toThrow('填写');
    expect(renders.appendImportedMaterials).not.toHaveBeenCalled();
    await service.confirm(
      'project',
      'batch',
      [
        {
          draftId: 'draft',
          promptText: '  手工描述  ',
          primaryPurpose: 'EFFECT',
          compatiblePurposes: ['EFFECT', 'PRODUCT_DISPLAY'],
        },
      ],
      1,
      'key',
    );
    expect(renders.appendImportedMaterials).toHaveBeenCalledWith(
      'project',
      'batch',
      [
        {
          draftId: 'draft',
          promptText: '手工描述',
          primaryPurpose: 'EFFECT',
          compatiblePurposes: ['EFFECT', 'PRODUCT_DISPLAY'],
        },
      ],
      1,
      'key',
    );
  });
  it('checks editing authority before staging or description dispatch', async () => {
    const { service, render, drafts, upload } = fixture();
    render.importContext.mockRejectedValue(new Error('not writable'));
    await expect(service.stage('project', 'batch', 'key', upload)).rejects.toThrow('not writable');
    await expect(service.describe('project', 'batch', 'draft', 'key')).rejects.toThrow(
      'not writable',
    );
    expect(drafts.describe).not.toHaveBeenCalled();
  });
  it('isolates batch and does not cancel confirmed imports', async () => {
    const { service, drafts } = fixture();
    await expect(service.cancel('project', 'different-batch', 'draft')).rejects.toThrow('不存在');
    expect(drafts.cancel).not.toHaveBeenCalled();
  });
  it('rejects old worker callbacks and empty model output', async () => {
    const { service, drafts } = fixture();
    drafts.finish.mockResolvedValue({ count: 0 });
    await expect(
      service.finish('project', 'draft', 'old-token', '描述', 'EFFECT', ['EFFECT']),
    ).rejects.toThrow('租约');
    await expect(service.finish('project', 'draft', 'token', ' ')).rejects.toThrow('结果无效');
    expect(drafts.finish).toHaveBeenCalledTimes(1);
    await expect(service.finish('project', 'draft', undefined as never, '描述')).rejects.toThrow(
      '租约',
    );
    await expect(service.heartbeat('project', 'draft', '')).rejects.toThrow('租约');
    expect(drafts.finish).toHaveBeenCalledTimes(1);
  });
  it.each([
    { primaryPurpose: undefined, compatiblePurposes: ['EFFECT'] },
    { primaryPurpose: 'EFFECT', compatiblePurposes: [] },
    { primaryPurpose: 'PAIN', compatiblePurposes: ['PAIN'] },
    { primaryPurpose: 'EFFECT', compatiblePurposes: ['HOOK'] },
    { primaryPurpose: 'EFFECT', compatiblePurposes: ['EFFECT', 'EFFECT'] },
  ])('rejects invalid manual purposes before creating materials: %j', async (purposes) => {
    const { service, renders } = fixture();
    await expect(
      service.confirm(
        'project',
        'batch',
        [{ draftId: 'draft', promptText: '描述', ...purposes }] as never,
        1,
        'key',
      ),
    ).rejects.toThrow('类型');
    expect(renders.appendImportedMaterials).not.toHaveBeenCalled();
  });
  it('persists a complete AI result and rejects incomplete success callbacks', async () => {
    const { service, drafts } = fixture();
    await service.finish('project', 'draft', 'token', '  AI 描述  ', 'HOOK', ['HOOK', 'EFFECT']);
    expect(drafts.finish).toHaveBeenCalledWith(
      'project',
      'draft',
      'token',
      'AI 描述',
      'HOOK',
      ['HOOK', 'EFFECT'],
      {},
    );
    await expect(service.finish('project', 'draft', 'token', '描述')).rejects.toThrow(
      '类型结果无效',
    );
    expect(drafts.finish).toHaveBeenCalledTimes(1);
    await service.finish('project', 'draft', 'token', null);
    expect(drafts.finish).toHaveBeenLastCalledWith(
      'project',
      'draft',
      'token',
      null,
      undefined,
      undefined,
      {},
    );
  });
  it('persists only a known safe failure message and rejects conflicting or untrusted failure codes', async () => {
    const { service, drafts } = fixture();
    await service.finish('project', 'draft', 'token', null, undefined, undefined, {}, 'AI_TIMEOUT');
    expect(drafts.finish).toHaveBeenLastCalledWith(
      'project',
      'draft',
      'token',
      null,
      undefined,
      undefined,
      {},
      EFFECT_SEGMENT_IMPORT_FAILURE_MESSAGES.AI_TIMEOUT,
    );
    await expect(
      service.finish('project', 'draft', 'token', '描述', 'EFFECT', ['EFFECT'], {}, 'AI_TIMEOUT'),
    ).rejects.toThrow('失败原因无效');
    await expect(
      service.finish(
        'project',
        'draft',
        'token',
        null,
        undefined,
        undefined,
        {},
        'raw-secret-response' as never,
      ),
    ).rejects.toThrow('失败原因无效');
    expect(drafts.finish).toHaveBeenCalledTimes(1);
  });
  it('accepts legacy callbacks and prevents raw error text from crossing the failure-code DTO', async () => {
    const value = Object.assign(new ImportCompleteDto(), {
      projectId: '08ae1473-d426-4351-ad2e-db5ea3e9b86e',
    });
    expect(await validate(value, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    value.failureCode = 'AI_RATE_LIMITED';
    expect(await validate(value, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    value.failureCode = 'private-provider-response' as never;
    expect((await validate(value)).some((error) => error.property === 'failureCode')).toBe(true);
    value.failureCode = 'AI_TIMEOUT';
    Object.assign(value, { errorMessage: 'private-provider-response' });
    expect(
      (await validate(value, { whitelist: true, forbidNonWhitelisted: true })).some(
        (error) => error.property === 'errorMessage',
      ),
    ).toBe(true);
  });
  it('allows optional creative fields to be empty and saves edits without an AI call', async () => {
    const { service, renders, drafts } = fixture();
    await service.confirm(
      'project',
      'batch',
      [
        {
          draftId: 'draft',
          promptText: '描述',
          primaryPurpose: 'EFFECT',
          compatiblePurposes: ['EFFECT'],
          creativeCore: '',
          dimensions: { scene: ' 餐桌 ', narrative: '' },
        },
      ],
      1,
      'key',
    );
    expect(renders.appendImportedMaterials).toHaveBeenCalledWith(
      'project',
      'batch',
      expect.arrayContaining([
        expect.objectContaining({ creativeCore: '', dimensions: { scene: '餐桌', narrative: '' } }),
      ]),
      1,
      'key',
    );
    expect(drafts.describe).not.toHaveBeenCalled();
    await service.finish('project', 'draft', 'token', 'AI 描述', 'EFFECT', ['EFFECT'], {
      creativeCore: 'AI 创意',
      dimensions: { scene: '餐桌' },
    });
    expect(drafts.finish).toHaveBeenLastCalledWith(
      'project',
      'draft',
      'token',
      'AI 描述',
      'EFFECT',
      ['EFFECT'],
      { creativeCore: 'AI 创意', dimensions: { scene: '餐桌' } },
    );
  });
});
