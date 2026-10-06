import { computed, reactive, ref } from 'vue';
import {
  EFFECT_SEGMENT_RENDER_LIMITS,
  effectSegmentImportDescriptionValid,
  type EffectSegmentImportDraft,
  type EffectSegmentRenderBatch,
} from '@ai-marketing/contracts';
import * as importsApi from './api/effect-segment-render.api';
import { applyEffectSegmentImportRecognition } from './effect-segment-import-state';

export type ImportColumn = {
  key: string;
  file: File;
  previewUrl: string;
  previewSize: { width: number; height: number } | null;
  previewError: boolean;
  video: HTMLVideoElement | null;
  draft: EffectSegmentImportDraft | null;
  uploading: boolean;
  uploadQueued: boolean;
  removing: boolean;
  confirming: boolean;
  requestingRecognition: boolean;
  error: string;
  confirmRequest: { fingerprint: string; key: string } | null;
};
type Scope = { projectId: string; batchId: string };
type ImportApi = Pick<
  typeof importsApi,
  | 'stageEffectSegmentImport'
  | 'describeEffectSegmentImport'
  | 'getEffectSegmentImport'
  | 'cancelEffectSegmentImport'
  | 'confirmEffectSegmentImports'
>;

const safeError = (error: unknown, fallback: string): string =>
  (error instanceof Error ? error.message : fallback)
    .replace(/(?:https?|tos|s3):\/\/\S+/giu, '[链接已隐藏]')
    .slice(0, 300);

export const importRecognitionBusy = (column: ImportColumn): boolean =>
  column.requestingRecognition ||
  (!!column.draft && ['QUEUED', 'RUNNING'].includes(column.draft.descriptionStatus));
export const importRecognitionLabel = (column: ImportColumn): string =>
  importRecognitionBusy(column)
    ? '智能识别中…'
    : column.draft && column.draft.descriptionStatus !== 'IDLE'
      ? '重新智能识别视频'
      : '智能识别视频';
export const importColumnLocked = (column: ImportColumn): boolean =>
  column.uploading ||
  column.uploadQueued ||
  column.removing ||
  column.confirming ||
  importRecognitionBusy(column);
export const importColumnError = (column: ImportColumn): string => {
  const message =
    column.error ||
    column.draft?.errorMessage ||
    (column.draft?.descriptionStatus === 'FAILED'
      ? 'AI 描述生成失败：未记录具体原因，可重新识别或手工填写。'
      : '');
  return message ? safeError(new Error(message), '视频处理失败，请重试') : '';
};
export const importColumnReady = (column: ImportColumn): boolean =>
  !importColumnLocked(column) &&
  !!column.draft &&
  column.draft.status === 'READY' &&
  effectSegmentImportDescriptionValid(column.draft);

/** UI-only batch coordinator; each column continues to use the existing server draft. */
export function createEffectSegmentImportBatch(options: {
  revision: () => number | null | undefined;
  imported: (batch: EffectSegmentRenderBatch, count: number) => void;
  api?: ImportApi;
}) {
  const api = options.api ?? importsApi;
  const columns = ref<ImportColumn[]>([]);
  const error = ref('');
  const confirming = computed(() => columns.value.some((column) => column.confirming));
  let scope: Scope | null = null;
  let generation = 0;
  let polling: ReturnType<typeof setTimeout> | undefined;
  let pollingGeneration: number | null = null;
  let confirmQueue = Promise.resolve();
  let uploadSlots = 2;
  const uploadWaiters: Array<() => void> = [];
  const withUploadSlot = async (action: () => Promise<void>) => {
    if (uploadSlots > 0) uploadSlots--;
    else await new Promise<void>((resolve) => uploadWaiters.push(resolve));
    try {
      await action();
    } finally {
      const waiting = uploadWaiters.shift();
      if (waiting) waiting();
      else uploadSlots++;
    }
  };
  const current = (column: ImportColumn, session: number) =>
    generation === session && columns.value.includes(column);
  const cancel = (target: Scope, id: string) =>
    api.cancelEffectSegmentImport(target.projectId, target.batchId, id).catch(() => undefined);
  const release = (column: ImportColumn) => {
    column.video?.pause();
    URL.revokeObjectURL(column.previewUrl);
  };
  const dispose = () => {
    generation++;
    if (polling) clearTimeout(polling);
    polling = undefined;
    for (const column of columns.value) {
      release(column);
      if (scope && column.draft?.status === 'READY') void cancel(scope, column.draft.id);
    }
    columns.value = [];
    scope = null;
    error.value = '';
  };
  const start = (target: Scope) => {
    if (scope?.projectId === target.projectId && scope.batchId === target.batchId) return;
    dispose();
    scope = { ...target };
    confirmQueue = Promise.resolve();
  };
  const hide = () => columns.value.forEach((column) => column.video?.pause());
  const upload = async (column: ImportColumn, target: Scope, session: number) => {
    if (!current(column, session) || column.uploading) return;
    column.uploading = true;
    column.error = '';
    try {
      if (
        !/\.(?:mp4|mov|webm)$/iu.test(column.file.name) ||
        column.file.size < 1 ||
        column.file.size > EFFECT_SEGMENT_RENDER_LIMITS.maxUploadBytes
      )
        throw new Error('仅支持不超过 512 MB 的 MP4、MOV、WebM');
      const response = await api.stageEffectSegmentImport(
        target.projectId,
        target.batchId,
        column.file,
        column.key,
      );
      if (!current(column, session)) {
        await cancel(target, response.data.draft.id);
        return;
      }
      column.draft = {
        ...response.data.draft,
        compatiblePurposes: [...(response.data.draft.compatiblePurposes ?? [])],
        creativeCore: response.data.draft.creativeCore ?? '',
        dimensions: { ...response.data.draft.dimensions },
      };
    } catch (cause) {
      if (current(column, session)) column.error = safeError(cause, '视频校验失败，请重试');
    } finally {
      column.uploading = false;
    }
  };
  const addFiles = async (files: File[]) => {
    const target = scope;
    if (!target || !files.length) return;
    if (
      columns.value.length + files.length >
      EFFECT_SEGMENT_RENDER_LIMITS.maxImportFilesPerOperation
    ) {
      error.value = '最多同时导入 5 个视频，请减少选择或先确认现有视频';
      return;
    }
    error.value = '';
    const session = generation;
    const added = files.map((file) =>
      reactive<ImportColumn>({
        key: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
        previewSize: null,
        previewError: false,
        video: null,
        draft: null,
        uploading: false,
        uploadQueued: false,
        removing: false,
        confirming: false,
        requestingRecognition: false,
        error: '',
        confirmRequest: null,
      }),
    );
    columns.value.push(...added);
    // Capacity is shared even when the user adds another selection during uploads.
    await Promise.all(added.map((column) => queueUpload(column, target, session)));
  };
  const queueUpload = async (column: ImportColumn, target: Scope, session: number) => {
    if (column.uploading || column.uploadQueued) return;
    column.uploadQueued = true;
    try {
      await withUploadSlot(() => upload(column, target, session));
    } finally {
      column.uploadQueued = false;
    }
  };
  const retryUpload = async (column: ImportColumn) => {
    const target = scope;
    const session = generation;
    if (target && !column.draft && !column.removing) await queueUpload(column, target, session);
  };
  const poll = async (): Promise<void> => {
    if (polling) clearTimeout(polling);
    const target = scope;
    const session = generation;
    if (!target || pollingGeneration === session) return;
    pollingGeneration = session;
    try {
      await Promise.all(
        columns.value
          .filter(
            (column) =>
              column.draft && !column.requestingRecognition && importRecognitionBusy(column),
          )
          .map(async (column) => {
            try {
              const response = await api.getEffectSegmentImport(
                target.projectId,
                target.batchId,
                column.draft!.id,
              );
              if (!current(column, session) || !column.draft) return;
              applyEffectSegmentImportRecognition(column.draft, response.data.draft);
              column.error = '';
            } catch (cause) {
              if (current(column, session))
                column.error = safeError(cause, '读取识别进度失败，将继续尝试');
            }
          }),
      );
    } finally {
      if (pollingGeneration === session) pollingGeneration = null;
      if (scope && generation === session && columns.value.some(importRecognitionBusy))
        polling = setTimeout(() => void poll(), 1500);
    }
  };
  const recognize = async (column: ImportColumn) => {
    const target = scope;
    if (!target || !column.draft || importColumnLocked(column)) return;
    const session = generation;
    column.requestingRecognition = true;
    column.draft.descriptionStatus = 'QUEUED';
    column.draft.errorMessage = null;
    column.error = '';
    try {
      const response = await api.describeEffectSegmentImport(
        target.projectId,
        target.batchId,
        column.draft.id,
        crypto.randomUUID(),
      );
      if (current(column, session))
        applyEffectSegmentImportRecognition(column.draft, response.data.draft);
    } catch (cause) {
      if (current(column, session)) {
        column.draft.descriptionStatus = 'FAILED';
        column.draft.errorMessage = safeError(cause, 'AI 识别失败，可重试或手工填写');
      }
    } finally {
      column.requestingRecognition = false;
      if (current(column, session)) void poll();
    }
  };
  const recognizeAll = () => Promise.all(columns.value.map(recognize));
  const drop = (column: ImportColumn) => {
    columns.value = columns.value.filter((item) => item !== column);
    release(column);
  };
  const remove = async (column: ImportColumn) => {
    const target = scope;
    if (!target || column.confirming || column.removing) return;
    const session = generation;
    column.removing = true;
    try {
      if (column.draft)
        await api.cancelEffectSegmentImport(target.projectId, target.batchId, column.draft.id);
      if (current(column, session)) {
        drop(column);
        error.value = '';
      }
    } catch (cause) {
      if (current(column, session)) column.error = safeError(cause, '取消导入失败，请重试');
    } finally {
      column.removing = false;
    }
  };
  const confirm = async (column: ImportColumn) => {
    const target = scope;
    if (!target || !importColumnReady(column)) return;
    const session = generation;
    const draft = column.draft!;
    const item = {
      draftId: draft.id,
      promptText: draft.promptText.trim(),
      primaryPurpose: draft.primaryPurpose!,
      compatiblePurposes: [...draft.compatiblePurposes!],
      creativeCore: draft.creativeCore ?? '',
      dimensions: { ...draft.dimensions },
    };
    const fingerprint = JSON.stringify(item);
    if (column.confirmRequest?.fingerprint !== fingerprint)
      column.confirmRequest = { fingerprint, key: crypto.randomUUID() };
    const key = column.confirmRequest.key;
    column.confirming = true;
    column.error = '';
    const work = confirmQueue.then(async () => {
      if (!current(column, session)) return;
      try {
        const revision = options.revision();
        if (typeof revision !== 'number') throw new Error('批次状态不可用，请重新进入导入窗口');
        const response = await api.confirmEffectSegmentImports(target.projectId, target.batchId, {
          items: [item],
          expectedBatchRevision: revision,
          idempotencyKey: key,
        });
        if (!current(column, session)) return;
        draft.status = 'IMPORTED';
        options.imported(response.data.batch, response.data.importedCount);
        drop(column);
      } catch (cause) {
        if (current(column, session)) column.error = safeError(cause, '导入失败，请重试');
      } finally {
        column.confirming = false;
      }
    });
    confirmQueue = work.catch(() => undefined);
    await work;
  };
  return {
    columns,
    error,
    confirming,
    start,
    hide,
    dispose,
    addFiles,
    retryUpload,
    recognize,
    recognizeAll,
    remove,
    confirm,
  };
}
