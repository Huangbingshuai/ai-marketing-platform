import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectSegmentImportDraft, EffectSegmentRenderBatch } from '@ai-marketing/contracts';
import {
  createEffectSegmentImportBatch,
  importColumnReady,
  importRecognitionBusy,
  importRecognitionLabel,
  importColumnError,
} from './effect-segment-import-batch';

const files = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => new File(['video'], `${i + 1}.mp4`, { type: 'video/mp4' }),
  );
const draft = (
  id: string,
  descriptionStatus: EffectSegmentImportDraft['descriptionStatus'] = 'IDLE',
): EffectSegmentImportDraft => ({
  id,
  fileName: id,
  durationSeconds: 6,
  sizeBytes: 5,
  width: 720,
  height: 1280,
  frameRate: 30,
  status: 'READY',
  descriptionStatus,
  promptText: '',
  primaryPurpose: null,
  compatiblePurposes: [],
  creativeCore: '',
  dimensions: {},
  errorMessage: null,
});
const response = (value: EffectSegmentImportDraft) => ({ data: { draft: value } });
const completed = (id: string) => ({
  ...draft(id, 'COMPLETED'),
  promptText: `AI ${id}`,
  primaryPurpose: 'EFFECT' as const,
  compatiblePurposes: ['EFFECT'] as const,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const cleanup: Array<() => void> = [];
function fixture() {
  let revision = 10;
  const api = {
    stageEffectSegmentImport: vi.fn(async (_p: string, _b: string, file: File) =>
      response(draft(file.name)),
    ),
    cancelEffectSegmentImport: vi.fn(async () => ({ data: { cancelled: true } })),
    describeEffectSegmentImport: vi.fn(async (_p: string, _b: string, id: string, _key: string) =>
      response(draft(id, 'QUEUED')),
    ),
    getEffectSegmentImport: vi.fn(async (_p: string, _b: string, id: string) =>
      response({ ...completed(id), compatiblePurposes: ['EFFECT'] }),
    ),
    confirmEffectSegmentImports: vi.fn(async () => ({
      data: {
        batch: { id: 'batch', revision: revision + 1 } as EffectSegmentRenderBatch,
        importedCount: 1,
        replayed: false,
      },
    })),
  };
  const imported = vi.fn((batch: EffectSegmentRenderBatch) => {
    revision = batch.revision;
  });
  const batch = createEffectSegmentImportBatch({
    revision: () => revision,
    imported,
    api: api as never,
  });
  batch.start({ projectId: 'project', batchId: 'batch' });
  cleanup.push(batch.dispose);
  const fill = () =>
    batch.columns.value.forEach((column) =>
      Object.assign(column.draft!, {
        promptText: `手工 ${column.key}`,
        primaryPurpose: 'HOOK',
        compatiblePurposes: ['HOOK'],
      }),
    );
  return { batch, api, imported, fill };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${crypto.randomUUID()}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('isolated batch import columns', () => {
  it('shows persistent failure details per column and clears them immediately on explicit re-recognition', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(2));
    const [left, right] = batch.columns.value;
    Object.assign(left!.draft!, {
      descriptionStatus: 'FAILED',
      errorMessage: 'AI 识别超时：识别服务未在规定时间内返回。',
      promptText: '用户已经填写的正文',
    });
    expect(importColumnError(left!)).toContain('识别超时');
    expect(importColumnError(right!)).toBe('');
    batch.hide();
    batch.start({ projectId: 'project', batchId: 'batch' });
    expect(importColumnError(left!)).toContain('识别超时');
    const waiting = deferred<ReturnType<typeof response>>();
    api.describeEffectSegmentImport.mockImplementationOnce(() => waiting.promise);
    const recognizing = batch.recognize(left!);
    expect(importColumnError(left!)).toBe('');
    expect(left!.draft!.promptText).toBe('用户已经填写的正文');
    waiting.resolve(response(draft('1.mp4', 'QUEUED')));
    await recognizing;
  });
  it('falls back safely for old failures and presents operation errors in the same place', async () => {
    const { batch } = fixture();
    await batch.addFiles(files(1));
    const column = batch.columns.value[0]!;
    column.draft!.descriptionStatus = 'FAILED';
    expect(importColumnError(column)).toContain('未记录具体原因');
    column.error = '读取失败 https://private.invalid/path?signature=private';
    expect(importColumnError(column)).toBe('读取失败 [链接已隐藏]');
  });
  it('uses first/re-recognition labels from persisted state, independent of manual text', async () => {
    const { batch } = fixture();
    await batch.addFiles(files(1));
    const column = batch.columns.value[0]!;
    expect(importRecognitionLabel(column)).toBe('智能识别视频');
    column.draft!.promptText = '手工内容不是 AI 识别记录';
    expect(importRecognitionLabel(column)).toBe('智能识别视频');
    for (const status of ['QUEUED', 'RUNNING'] as const) {
      column.draft!.descriptionStatus = status;
      expect(importRecognitionLabel(column)).toBe('智能识别中…');
    }
    for (const status of ['COMPLETED', 'FAILED'] as const) {
      column.draft!.descriptionStatus = status;
      expect(importRecognitionLabel(column)).toBe('重新智能识别视频');
    }
    batch.hide();
    batch.start({ projectId: 'project', batchId: 'batch' });
    expect(importRecognitionLabel(column)).toBe('重新智能识别视频');
  });
  it('re-recognition uses a new request and replaces all manual edits only after success', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(1));
    const column = batch.columns.value[0]!;
    await batch.recognize(column);
    await flush();
    expect(importRecognitionLabel(column)).toBe('重新智能识别视频');
    Object.assign(column.draft!, {
      promptText: '人工改过的正文',
      primaryPurpose: 'HOOK',
      compatiblePurposes: ['HOOK'],
      creativeCore: '人工创意',
      dimensions: { camera: '人工镜头' },
    });
    api.getEffectSegmentImport.mockResolvedValue(
      response({
        ...completed('1.mp4'),
        compatiblePurposes: ['EFFECT'],
        creativeCore: '重新识别的创意',
        dimensions: { camera: '重新识别的镜头' },
      }) as never,
    );
    await batch.recognize(column);
    await flush();
    expect(api.describeEffectSegmentImport).toHaveBeenCalledTimes(2);
    expect(api.describeEffectSegmentImport.mock.calls[0]![3]).not.toBe(
      api.describeEffectSegmentImport.mock.calls[1]![3],
    );
    expect(column.draft).toMatchObject({
      promptText: 'AI 1.mp4',
      primaryPurpose: 'EFFECT',
      compatiblePurposes: ['EFFECT'],
      creativeCore: '重新识别的创意',
      dimensions: { camera: '重新识别的镜头' },
    });
    expect(importRecognitionLabel(column)).toBe('重新智能识别视频');
  });
  it('keeps a duplicate-content error isolated and disables confirm and recognition for it', async () => {
    const { batch, api } = fixture();
    api.stageEffectSegmentImport.mockRejectedValueOnce(
      new Error('该视频已作为人工素材 R-021 导入，请勿重复导入'),
    );
    await batch.addFiles(files(2));
    const [duplicate, valid] = batch.columns.value;
    expect(duplicate!.error).toContain('R-021');
    expect(duplicate!.draft).toBeNull();
    expect(importColumnReady(duplicate!)).toBe(false);
    Object.assign(valid!.draft!, {
      promptText: '新视频',
      primaryPurpose: 'HOOK',
      compatiblePurposes: ['HOOK'],
    });
    expect(importColumnReady(valid!)).toBe(true);
    await batch.recognize(duplicate!);
    await batch.confirm(duplicate!);
    expect(api.describeEffectSegmentImport).not.toHaveBeenCalled();
    expect(api.confirmEffectSegmentImports).not.toHaveBeenCalled();
    await batch.remove(duplicate!);
    expect(batch.columns.value).toHaveLength(1);
    expect(batch.columns.value[0]).toBe(valid);
  });
  it('retains files, edits, URLs and AI polling after hiding and reopening the same batch', async () => {
    const { batch, api, fill } = fixture();
    await batch.addFiles(files(2));
    fill();
    const first = batch.columns.value[0]!;
    const pause = vi.fn();
    first.video = { pause } as unknown as HTMLVideoElement;
    await batch.recognize(batch.columns.value[1]!);
    batch.hide();
    batch.start({ projectId: 'project', batchId: 'batch' });
    expect(batch.columns.value[0]).toBe(first);
    expect(first.draft?.promptText).toContain('手工');
    expect(pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(api.cancelEffectSegmentImport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(batch.columns.value[1]?.draft?.descriptionStatus).toBe('COMPLETED');
    batch.dispose();
    batch.start({ projectId: 'project', batchId: 'batch' });
    expect(batch.columns.value).toHaveLength(0);
  });
  it('does not inherit pending columns when the batch or project changes', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(1));
    batch.hide();
    batch.start({ projectId: 'other-project', batchId: 'other-batch' });
    expect(batch.columns.value).toHaveLength(0);
    expect(api.cancelEffectSegmentImport).toHaveBeenCalledWith('project', 'batch', '1.mp4');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
  it.each([1, 5])(
    'keeps %s files in selection order with independent previews and drafts',
    async (count) => {
      const { batch, api } = fixture();
      await batch.addFiles(files(count));
      expect(batch.columns.value.map((column) => column.file.name)).toEqual(
        files(count).map((file) => file.name),
      );
      expect(new Set(batch.columns.value.map((column) => column.previewUrl)).size).toBe(count);
      expect(api.stageEffectSegmentImport).toHaveBeenCalledTimes(count);
      expect(batch.columns.value.every((column) => !importColumnReady(column))).toBe(true);
      expect(api.describeEffectSegmentImport).not.toHaveBeenCalled();
    },
  );
  it('rejects a sixth file before upload and counts already reserved columns', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(6));
    expect(batch.error.value).toContain('5');
    expect(api.stageEffectSegmentImport).not.toHaveBeenCalled();
    await batch.addFiles(files(5));
    await batch.addFiles(files(1));
    expect(api.stageEffectSegmentImport).toHaveBeenCalledTimes(5);
    expect(batch.columns.value).toHaveLength(5);
  });
  it('bounds upload concurrency across separate file selections and preserves partial failures', async () => {
    const { batch, api } = fixture();
    const a = deferred<ReturnType<typeof response>>();
    const b = deferred<ReturnType<typeof response>>();
    api.stageEffectSegmentImport
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise)
      .mockRejectedValueOnce(new Error('时长必须在 4～30 秒'));
    const first = batch.addFiles(files(2));
    const second = batch.addFiles([new File(['video'], 'third.mp4')]);
    expect(batch.columns.value).toHaveLength(3);
    expect(api.stageEffectSegmentImport).toHaveBeenCalledTimes(2);
    a.resolve(response(draft('1.mp4')));
    await flush();
    expect(api.stageEffectSegmentImport).toHaveBeenCalledTimes(3);
    b.resolve(response(draft('2.mp4')));
    await Promise.all([first, second]);
    expect(batch.columns.value[2]!.error).toContain('4～30');
    expect(batch.columns.value[0]!.draft?.id).toBe('1.mp4');
  });
  it('cancels late upload results in their original scope without changing a new session', async () => {
    const { batch, api } = fixture();
    const waiting = deferred<ReturnType<typeof response>>();
    api.stageEffectSegmentImport.mockImplementationOnce(() => waiting.promise);
    const pending = batch.addFiles(files(1));
    batch.start({ projectId: 'new-project', batchId: 'new-batch' });
    await batch.addFiles([new File(['video'], 'new.mp4')]);
    waiting.resolve(response(draft('old-id')));
    await pending;
    expect(api.cancelEffectSegmentImport).toHaveBeenCalledWith('project', 'batch', 'old-id');
    expect(batch.columns.value[0]!.draft?.id).toBe('new.mp4');
  });
  it('submits recognition concurrently, ignores repeated clicks and isolates polling errors', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(2));
    const a = deferred<ReturnType<typeof response>>();
    const b = deferred<ReturnType<typeof response>>();
    api.describeEffectSegmentImport
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);
    const pending = batch.recognizeAll();
    expect(api.describeEffectSegmentImport).toHaveBeenCalledTimes(2);
    await batch.recognizeAll();
    expect(api.describeEffectSegmentImport).toHaveBeenCalledTimes(2);
    expect(batch.columns.value.every(importRecognitionBusy)).toBe(true);
    api.getEffectSegmentImport.mockRejectedValueOnce(new Error('临时读取失败'));
    a.resolve(response(draft('1.mp4', 'QUEUED')));
    b.resolve(response(draft('2.mp4', 'QUEUED')));
    await pending;
    await flush();
    expect(batch.columns.value[0]!.error).toContain('读取失败');
    await vi.advanceTimersByTimeAsync(1500);
    expect(batch.columns.value[1]!.draft?.promptText).toBe('AI 2.mp4');
    expect(batch.columns.value[1]!.draft?.frameRate).toBe(30);
  });
  it('keeps simultaneous individual recognition results isolated when one backend job fails', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(2));
    const [left, right] = batch.columns.value;
    const leftQueued = deferred<ReturnType<typeof response>>();
    const rightQueued = deferred<ReturnType<typeof response>>();
    api.describeEffectSegmentImport
      .mockImplementationOnce(() => leftQueued.promise)
      .mockImplementationOnce(() => rightQueued.promise);
    api.getEffectSegmentImport.mockImplementation(async (_p, _b, id) =>
      response(
        id === '1.mp4'
          ? { ...draft(id, 'FAILED'), errorMessage: 'AI 描述生成失败' }
          : {
              ...completed(id),
              compatiblePurposes: ['EFFECT'],
              creativeCore: '右侧创意',
              dimensions: { camera: '右侧镜头' },
            },
      ),
    );
    const first = batch.recognize(left!);
    const second = batch.recognize(right!);
    expect(api.describeEffectSegmentImport).toHaveBeenCalledTimes(2);
    rightQueued.resolve(response(draft('2.mp4', 'QUEUED')));
    await second;
    await flush();
    leftQueued.resolve(response(draft('1.mp4', 'QUEUED')));
    await first;
    await vi.advanceTimersByTimeAsync(1500);
    expect(left!.draft?.descriptionStatus).toBe('FAILED');
    expect(left!.draft?.promptText).toBe('');
    expect(importRecognitionBusy(left!)).toBe(false);
    expect(right!.draft).toMatchObject({
      descriptionStatus: 'COMPLETED',
      promptText: 'AI 2.mp4',
      primaryPurpose: 'EFFECT',
      compatiblePurposes: ['EFFECT'],
      creativeCore: '右侧创意',
      dimensions: { camera: '右侧镜头' },
    });
    expect(importColumnReady(right!)).toBe(true);
    expect(importRecognitionBusy(right!)).toBe(false);
  });
  it('removes just one recognizing column and rejects its late callback', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(2));
    const first = batch.columns.value[0]!;
    const second = batch.columns.value[1]!;
    const waiting = deferred<ReturnType<typeof response>>();
    api.describeEffectSegmentImport.mockImplementationOnce(() => waiting.promise);
    const recognizing = batch.recognize(first);
    await batch.remove(first);
    waiting.resolve(response(draft(first.draft!.id, 'QUEUED')));
    await recognizing;
    expect(batch.columns.value).toEqual([second]);
    expect(second.previewUrl).toBeTruthy();
    expect(second.draft?.descriptionStatus).toBe('IDLE');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first.previewUrl);
  });
  it('serializes confirmations using updated revisions and removes only each successful column', async () => {
    const { batch, api, fill } = fixture();
    await batch.addFiles(files(3));
    fill();
    const [first, second, third] = batch.columns.value;
    await Promise.all([batch.confirm(first!), batch.confirm(second!), batch.confirm(first!)]);
    expect(api.confirmEffectSegmentImports).toHaveBeenCalledTimes(2);
    const calls = api.confirmEffectSegmentImports.mock.calls as unknown as Array<
      [string, string, { expectedBatchRevision: number; items: unknown[] }]
    >;
    expect(calls.map((call) => call[2].expectedBatchRevision)).toEqual([10, 11]);
    expect(calls.every((call) => call[2].items.length === 1)).toBe(true);
    expect(batch.columns.value).toEqual([third]);
    expect(batch.confirming.value).toBe(false);
    expect(api.cancelEffectSegmentImport).not.toHaveBeenCalled();
  });
  it('preserves failed confirmation text and reuses its key before confirming again', async () => {
    const { batch, api, fill } = fixture();
    await batch.addFiles(files(1));
    fill();
    const column = batch.columns.value[0]!;
    const text = column.draft!.promptText;
    api.confirmEffectSegmentImports.mockRejectedValueOnce(new Error('网络失败'));
    await batch.confirm(column);
    expect(column.error).toContain('网络失败');
    expect(column.draft!.promptText).toBe(text);
    const key = column.confirmRequest!.key;
    await batch.confirm(column);
    expect(column.confirmRequest!.key).toBe(key);
    expect(batch.columns.value).toHaveLength(0);
  });
  it('AI submission failure preserves text and choices of both columns', async () => {
    const { batch, api, fill } = fixture();
    await batch.addFiles(files(2));
    fill();
    const first = batch.columns.value[0]!;
    const second = batch.columns.value[1]!;
    const text = first.draft!.promptText;
    api.describeEffectSegmentImport.mockRejectedValueOnce(new Error('识别服务失败'));
    await batch.recognize(first);
    expect(first.draft).toMatchObject({
      promptText: text,
      primaryPurpose: 'HOOK',
      descriptionStatus: 'FAILED',
    });
    expect(second.draft?.primaryPurpose).toBe('HOOK');
  });
  it('disposes all pending previews, drafts and scheduled polling', async () => {
    const { batch, api } = fixture();
    await batch.addFiles(files(2));
    api.getEffectSegmentImport.mockImplementation(async (_p, _b, id) =>
      response(draft(id, 'RUNNING')),
    );
    await batch.recognizeAll();
    await flush();
    batch.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(api.cancelEffectSegmentImport).toHaveBeenCalledTimes(2);
    const calls = api.getEffectSegmentImport.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.getEffectSegmentImport).toHaveBeenCalledTimes(calls);
  });
});
