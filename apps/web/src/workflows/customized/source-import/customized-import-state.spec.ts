import type { Asset } from '@ai-marketing/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  customizedImageUsageOptions,
  createCustomizedDraftPersistence,
  customizedFileError,
  emptyCustomizedImportDraft,
  isCustomizedSourceAsset,
  restoreCustomizedImportDraft,
  validateCustomizedImportDraft,
} from './customized-import-state';
import { customizedWorkflowNodes } from '../customized-workflow';
import pageSource from './CustomizedImportNodePage.vue?raw';

describe('customized source draft boundaries', () => {
  it('offers only brand usages for new images and keeps the current legacy usage available', () => {
    const options = customizedImageUsageOptions();
    expect(options.map((option) => option.value)).toEqual([
      '',
      'LOGO',
      'WORDMARK',
      'BRAND_GRAPHIC',
      'BRAND_IP',
      'PACKAGING',
    ]);
    expect(customizedImageUsageOptions('LOGO')).toEqual(options);
    expect(customizedImageUsageOptions('PRODUCT')).toEqual([
      ...options,
      { label: '产品参考（历史资料）', value: 'PRODUCT' },
    ]);
    for (const usage of ['PERSON', 'SCENE', 'STYLE', 'OTHER'] as const) {
      expect(customizedImageUsageOptions(usage).map((option) => option.value)).toEqual([
        ...options.map((option) => option.value),
        usage,
      ]);
    }
  });
  it('uses six nodes with asset binding owned by shot rendering', () => {
    expect(customizedWorkflowNodes.map((item) => item.id)).toEqual([
      'SOURCE_IMPORT',
      'INFORMATION_EXTRACTION',
      'STORYBOARD',
      'SHOT_PROMPT',
      'SHOT_RENDER',
      'DELIVERY',
    ]);
  });
  it('starts with an empty brief and restores all user supplied fields without examples', () => {
    const draft = emptyCustomizedImportDraft();
    expect(draft.requirements).toBe('');
    expect(draft.materials).toEqual([]);
    draft.requirements = '制作品牌视频';
    draft.materials.push({ assetId: 'a', assetVersion: 2, category: 'CHARACTER' });
    const restored = restoreCustomizedImportDraft(draft);
    expect(restored).toEqual(draft);
    restored.materials[0]!.assetVersion = 3;
    expect(draft.materials[0]!.assetVersion).toBe(2);
  });
  it.each([
    { schemaVersion: 4 },
    { ...emptyCustomizedImportDraft(), requirements: NaN },
    {
      ...emptyCustomizedImportDraft(),
      materials: [{ assetId: 'a', assetVersion: 0, category: 'BRIEF' }],
    },
    {
      ...emptyCustomizedImportDraft(),
      materials: [
        { assetId: 'a', assetVersion: 1, category: 'VISUAL_REFERENCE', imageUsage: 'UNKNOWN' },
      ],
    },
  ])('rejects incompatible saved state instead of silently discarding it: %j', (state) => {
    expect(() => restoreCustomizedImportDraft(state)).toThrow('资料草稿格式不正确');
  });
  it('checks file extension, empty data and upload limits', () => {
    expect(customizedFileError({ name: 'brief.PDF', size: 3 })).toBe('');
    expect(customizedFileError({ name: 'demo.mov', size: 512 * 1024 * 1024 })).toBe('');
    expect(customizedFileError({ name: 'run.exe', size: 3 })).not.toBe('');
    expect(customizedFileError({ name: 'brief.pdf', size: 0 })).toContain('不能为空');
    expect(customizedFileError({ name: 'brief.pdf', size: 512 * 1024 * 1024 + 1 })).toContain(
      '512 MB',
    );
  });
  it('accepts only source files from the current project and customized space', () => {
    const asset = {
      projectId: 'p',
      storageWorkflow: 'CUSTOMIZED',
      workflowSpace: 'CUSTOMIZED_PROJECT',
      directory: 'SOURCE_MATERIALS',
      type: 'SOURCE_MATERIAL',
      hasFile: true,
    } as Asset;
    expect(isCustomizedSourceAsset(asset, 'p')).toBe(true);
    expect(isCustomizedSourceAsset(asset, 'other')).toBe(false);
    expect(isCustomizedSourceAsset({ ...asset, storageWorkflow: 'EFFECT' }, 'p')).toBe(false);
    expect(
      isCustomizedSourceAsset({ ...asset, workflowSpace: 'CUSTOMIZED_VOICE_LIBRARY' }, 'p'),
    ).toBe(false);
    expect(isCustomizedSourceAsset({ ...asset, hasFile: false }, 'p')).toBe(false);
  });
  it('starts restoring referenced assets before the branch tree finishes loading', () => {
    const startAssets = pageSource.indexOf('const assetLoads = Promise.allSettled(');
    const awaitTree = pageSource.indexOf('const treeResult = await treePromise;');
    expect(startAssets).toBeGreaterThan(pageSource.indexOf('const treePromise ='));
    expect(startAssets).toBeLessThan(awaitTree);
  });
  it('requires documents while retaining historical text without an editor', () => {
    const draft = emptyCustomizedImportDraft();
    expect(validateCustomizedImportDraft(draft)).toHaveLength(1);
    Object.assign(draft, {
      requirements: '产品宣传',
      materials: [{ assetId: 'a', assetVersion: 1, category: 'BRIEF' }],
    });
    expect(validateCustomizedImportDraft(draft)).toEqual([]);
    draft.requirements = 'x'.repeat(40001);
    expect(restoreCustomizedImportDraft(draft).requirements).toHaveLength(40001);
    expect(validateCustomizedImportDraft(draft)).toEqual([]);
  });
});

describe('customized draft persistence', () => {
  const setup = (runId = 'r') => {
    const initial = emptyCustomizedImportDraft();
    let draft = structuredClone(initial);
    const initialize = vi.fn().mockResolvedValue('new-run');
    const put = vi.fn().mockResolvedValue(2);
    const status = vi.fn();
    const persistence = createCustomizedDraftPersistence(
      { snapshot: () => structuredClone(draft), initialize, put, status },
      { runId, revision: runId ? 1 : null, state: initial },
    );
    return {
      persistence,
      initialize,
      put,
      status,
      edit: (value: string) => {
        draft.requirements = value;
      },
      replace: () => {
        draft = emptyCustomizedImportDraft();
      },
    };
  };
  it('does not create a run or write revisions when unchanged', async () => {
    const s = setup('');
    expect(await s.persistence.flush()).toBe(true);
    expect(s.initialize).not.toHaveBeenCalled();
    expect(s.put).not.toHaveBeenCalled();
  });
  it('initializes once on the first actual edit, with no extra writes for repeated save', async () => {
    const s = setup('');
    s.edit('first');
    await s.persistence.flush();
    await s.persistence.flush();
    expect(s.initialize).toHaveBeenCalledTimes(1);
    expect(s.put).toHaveBeenCalledWith(
      'new-run',
      null,
      expect.objectContaining({ requirements: 'first' }),
    );
    expect(s.put).toHaveBeenCalledTimes(1);
  });
  it('serializes writes and saves a second edit made while the first request is in flight', async () => {
    const s = setup();
    let resolve!: (revision: number) => void;
    s.put.mockImplementationOnce(
      () =>
        new Promise<number>((r) => {
          resolve = r;
        }),
    );
    s.edit('first');
    const saving = s.persistence.flush();
    s.edit('second');
    expect(s.persistence.flush()).toBe(saving);
    expect(s.put).toHaveBeenCalledTimes(1);
    resolve(2);
    expect(await saving).toBe(true);
    expect(s.put).toHaveBeenLastCalledWith(
      'r',
      2,
      expect.objectContaining({ requirements: 'second' }),
    );
    expect(s.put).toHaveBeenCalledTimes(2);
    expect(s.persistence.dirty()).toBe(false);
  });
  it('retains edits and expected revision after failure; retries only on explicit flush', async () => {
    const s = setup();
    s.put.mockRejectedValueOnce(new Error('conflict'));
    s.edit('keep me');
    expect(await s.persistence.flush()).toBe(false);
    expect(s.persistence.dirty()).toBe(true);
    expect(s.put).toHaveBeenCalledTimes(1);
    expect(await s.persistence.flush()).toBe(true);
    expect(s.put).toHaveBeenLastCalledWith(
      'r',
      1,
      expect.objectContaining({ requirements: 'keep me' }),
    );
  });
  it('keeps separate project/run sessions isolated when an old response arrives', async () => {
    const old = setup('old-run');
    const current = setup('new-run');
    let finish!: (revision: number) => void;
    old.put.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    old.edit('old');
    const saving = old.persistence.flush();
    current.edit('new');
    await current.persistence.flush();
    finish(3);
    await saving;
    expect(current.put).toHaveBeenCalledTimes(1);
    expect(current.put).toHaveBeenCalledWith(
      'new-run',
      1,
      expect.objectContaining({ requirements: 'new' }),
    );
    expect(current.persistence.dirty()).toBe(false);
  });
});
