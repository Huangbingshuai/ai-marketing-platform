export {
  emptyCustomizedImportDraft,
  restoreCustomizedImportDraft,
  validateCustomizedImportDraft,
} from '@ai-marketing/contracts';
import {
  CUSTOMIZED_SOURCE_ARTIFACT_KEY,
  CUSTOMIZED_BRAND_IMAGE_USAGES,
  CUSTOMIZED_IMAGE_USAGE_LABELS,
  CUSTOMIZED_IMPORT_LIMITS,
  type Asset,
  type CustomizedImageUsage,
  type CustomizedImportDraftState,
  type WorkflowRun,
  type WorkflowNodeState,
  type WorkingArtifact,
} from '@ai-marketing/contracts';
import { restoreCustomizedImportDraft } from '@ai-marketing/contracts';

/** Confirmed branch snapshots are authoritative outside an explicit source edit. */
export const restoreCustomizedImportWorkspace = (
  projectId: string,
  run: WorkflowRun | null,
  states: WorkflowNodeState[],
  artifacts: WorkingArtifact[],
): CustomizedImportDraftState => {
  if (
    !run ||
    run.projectId !== projectId ||
    run.workflow !== 'CUSTOMIZED' ||
    run.workflowSpace !== 'CUSTOMIZED_PROJECT'
  )
    return restoreCustomizedImportDraft(undefined);
  const state = states.find(
    (s) => s.projectId === projectId && s.workflowRunId === run.id && s.nodeId === 'SOURCE_IMPORT',
  );
  const confirmed = artifacts.find(
    (a) =>
      a.projectId === projectId &&
      a.workflowRunId === run.id &&
      a.nodeId === 'SOURCE_IMPORT' &&
      a.artifactKey === CUSTOMIZED_SOURCE_ARTIFACT_KEY &&
      a.availability === 'AVAILABLE',
  );
  return restoreCustomizedImportDraft(
    run.editNodeId === 'SOURCE_IMPORT' && state
      ? state.state
      : confirmed
        ? confirmed.payload
        : state?.state,
  );
};

/** Keep only this file's historical usage selectable; never relabel it on read. */
export const customizedImageUsageOptions = (current?: CustomizedImageUsage) => {
  const options: { label: string; value: CustomizedImageUsage | '' }[] = [
    { label: '未指定用途', value: '' },
    ...CUSTOMIZED_BRAND_IMAGE_USAGES.map((value) => ({
      label: CUSTOMIZED_IMAGE_USAGE_LABELS[value],
      value,
    })),
  ];
  if (current && !options.some((option) => option.value === current))
    options.push({
      label: `${CUSTOMIZED_IMAGE_USAGE_LABELS[current]}（历史资料）`,
      value: current,
    });
  return options;
};

export const customizedFileError = (file: Pick<File, 'name' | 'size'>): string => {
  if (!/\.(docx|pdf|xlsx|txt|md|jpe?g|png|webp|psd|mp4|mov|webm)$/i.test(file.name))
    return '支持 Word、PDF、Excel、文本、图片与 MP4 / MOV / WebM 视频';
  if (file.size < 1) return '文件不能为空';
  if (file.size > 512 * 1024 * 1024) return '单个文件不能超过 512 MB';
  return '';
};

export const isCustomizedSourceAsset = (asset: Asset, projectId: string): boolean =>
  asset.projectId === projectId &&
  asset.storageWorkflow === 'CUSTOMIZED' &&
  asset.workflowSpace === 'CUSTOMIZED_PROJECT' &&
  asset.directory === 'SOURCE_MATERIALS' &&
  asset.type === 'SOURCE_MATERIAL' &&
  asset.hasFile !== false &&
  asset.status !== 'UNAVAILABLE';

export const isCustomizedImage = (asset: Asset | undefined): boolean =>
  Boolean(
    asset &&
    (/\.(jpe?g|png|webp|psd)$/i.test(asset.originalFileName) ||
      asset.mimeType?.startsWith('image/')),
  );
export const sectionFileError = (
  file: Pick<File, 'name' | 'size'>,
  section: 'BRIEF' | 'VISUAL_REFERENCE',
): string => {
  if (
    section === 'VISUAL_REFERENCE'
      ? !/\.(jpe?g|png|webp|psd)$/i.test(file.name)
      : !/\.(docx|pdf|xlsx|txt|md)$/i.test(file.name)
  )
    return section === 'VISUAL_REFERENCE'
      ? '此区域只支持 JPG、PNG、WebP、PSD 图片'
      : '此区域只支持 Word、PDF、Excel、TXT、Markdown 文档';
  if (file.size < 1) return '文件不能为空';
  const max =
    section === 'BRIEF'
      ? CUSTOMIZED_IMPORT_LIMITS.maxDocumentBytes
      : CUSTOMIZED_IMPORT_LIMITS.maxImageBytes;
  return file.size > max ? `单个文件不能超过 ${max / 1024 / 1024} MB` : '';
};

export type DraftPersistenceDriver = {
  snapshot: () => CustomizedImportDraftState;
  initialize: () => Promise<string>;
  put: (
    runId: string,
    revision: number | null,
    state: CustomizedImportDraftState,
  ) => Promise<number>;
  status: (status: 'saving' | 'saved' | 'error', error?: unknown) => void;
};

/** Serialize writes, keep edits made while saving, never retry a conflicting write automatically. */
export const createCustomizedDraftPersistence = (
  driver: DraftPersistenceDriver,
  initial: { runId: string; revision: number | null; state: CustomizedImportDraftState },
) => {
  let runId = initial.runId;
  let revision = initial.revision;
  let saved = JSON.stringify(initial.state);
  let saving: Promise<boolean> | null = null;
  const dirty = () => JSON.stringify(driver.snapshot()) !== saved;
  const flush = (): Promise<boolean> => {
    if (saving) return saving;
    if (!dirty()) return Promise.resolve(true);
    saving = (async () => {
      try {
        driver.status('saving');
        if (!runId) runId = await driver.initialize();
        while (dirty()) {
          const state = driver.snapshot();
          const snapshot = JSON.stringify(state);
          revision = await driver.put(runId, revision, state);
          saved = snapshot;
        }
        driver.status('saved');
        return true;
      } catch (error) {
        driver.status('error', error);
        return false;
      } finally {
        saving = null;
      }
    })();
    return saving;
  };
  return { flush, dirty, runId: () => runId, revision: () => revision };
};
