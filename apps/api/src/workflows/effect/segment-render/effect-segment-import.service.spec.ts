import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EffectSegmentImportService } from './effect-segment-import.service';
import { inspectImportVideo } from './effect-segment-import-media';
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
  durationSeconds: 10,
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
    delete: vi.fn(),
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
    mimeType: 'video/mp4',
  });
  return { service, drafts, renders, render, storage, upload };
}
describe('independent import drafts', () => {
  it('stages validated media without creating tasks, ignoring untrusted MIME', async () => {
    const { service, drafts, renders, storage, upload } = fixture();
    const result = await service.stage('project', 'batch', 'key', upload);
    expect(result.draft.status).toBe('READY');
    expect(drafts.stage).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'video/mp4', durationSeconds: 10 }),
    );
    expect(renders.appendImportedMaterials).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
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
      service.confirm('project', 'batch', [{ draftId: 'draft', promptText: ' ' }], 1, 'key'),
    ).rejects.toThrow('填写');
    expect(renders.appendImportedMaterials).not.toHaveBeenCalled();
    await service.confirm(
      'project',
      'batch',
      [{ draftId: 'draft', promptText: '  手工描述  ' }],
      1,
      'key',
    );
    expect(renders.appendImportedMaterials).toHaveBeenCalledWith(
      'project',
      'batch',
      [{ draftId: 'draft', promptText: '手工描述' }],
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
    await expect(service.finish('project', 'draft', 'old-token', '描述')).rejects.toThrow('租约');
    await expect(service.finish('project', 'draft', 'token', ' ')).rejects.toThrow('结果无效');
    expect(drafts.finish).toHaveBeenCalledTimes(1);
    await expect(service.finish('project', 'draft', undefined as never, '描述')).rejects.toThrow(
      '租约',
    );
    await expect(service.heartbeat('project', 'draft', '')).rejects.toThrow('租约');
    expect(drafts.finish).toHaveBeenCalledTimes(1);
  });
});
