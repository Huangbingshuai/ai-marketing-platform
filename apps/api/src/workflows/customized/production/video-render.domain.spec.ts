import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS as settings } from '@ai-marketing/contracts';
import { videoFileIssues, renderSettingsNode, freezeVideoRender } from './video-render.domain';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProductionWorkspace } from '@ai-marketing/contracts';
import type { Prisma, WorkingArtifact } from '../../../generated/prisma/client';
import { clipPayload } from './video-production.domain';
import type { ProductionVideoDocument, AssetPreparation } from '@ai-marketing/contracts';
describe('actual video validation', () => {
  function detailFixture() {
    const document = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
        ),
        'utf8',
      ),
    ).document as ProductionVideoDocument;
    const prep: AssetPreparation = {
      aliases: [],
      usage: '随父场景',
      treatment: 'SCENE_DETAIL',
      parentId: 'room',
      sources: [],
      details: [],
      questions: [],
      images: [],
    };
    Object.assign(document.assets[0]!, {
      kind: 'PROP',
      name: '木边柜',
      preparation: prep,
      image: { assetId: 'old-child', version: 1 },
    });
    document.assets[1]!.image = { assetId: 'parent-image', version: 7 };
    const artifacts = [
      {
        artifactKey: 'customized-video-clip:clip-a',
        freshness: 'CURRENT',
        payload: clipPayload(document, 'clip-a'),
      },
      {
        artifactKey: 'customized-clip-prompt:clip-a',
        freshness: 'CURRENT',
        payload: {
          target: { kind: 'CLIP', id: 'clip-a' },
          content: '@木边柜位于@阅读室窗边。',
          assetIds: ['cup', 'room'],
        },
      },
    ] as unknown as WorkingArtifact[];
    const versions = {
      findFirst: vi.fn().mockResolvedValue({
        storageKey: 'frozen-parent-v7',
        mimeType: 'image/png',
        sizeBytes: 123,
      }),
    };
    const files = {
      findFirst: vi.fn().mockResolvedValue({ sizeBytes: 123, sha256: 'a'.repeat(64) }),
    };
    return {
      document,
      artifacts,
      versions,
      files,
      tx: { assetVersion: versions, fileObject: files } as unknown as Prisma.TransactionClient,
    };
  }
  it('freezes the explicit parent image version for child and parent references without using a historical child image', async () => {
    const f = detailFixture();
    const result = await freezeVideoRender(
      f.tx,
      'project',
      { document: f.document } as ProductionWorkspace,
      f.artifacts,
      'clip-a',
      settings,
      'controlled',
    );
    expect(result.input.references).toEqual([
      {
        objectId: 'cup',
        name: '木边柜',
        sourceObjectId: 'room',
        sourceName: '阅读室',
        assetId: 'parent-image',
        version: 7,
        storageKey: 'frozen-parent-v7',
        mimeType: 'image/png',
        sizeBytes: 123,
        sha256: 'a'.repeat(64),
      },
      {
        objectId: 'room',
        name: '阅读室',
        assetId: 'parent-image',
        version: 7,
        storageKey: 'frozen-parent-v7',
        mimeType: 'image/png',
        sizeBytes: 123,
        sha256: 'a'.repeat(64),
      },
    ]);
    for (const [query] of f.versions.findFirst.mock.calls)
      expect(query.where).toMatchObject({
        projectId: 'project',
        assetId: 'parent-image',
        version: 7,
      });
    expect(f.files.findFirst).toHaveBeenCalledWith({
      where: { projectId: 'project', storageKey: 'frozen-parent-v7', status: 'AVAILABLE' },
    });
    f.document.assets[1]!.image = { assetId: 'new-parent-image', version: 8 };
    expect(
      result.input.references.every((r) => r.assetId === 'parent-image' && r.version === 7),
    ).toBe(true);
  });
  it.each([
    'missing-parent',
    'missing-image',
    'foreign-project-file',
    'unavailable-file',
    'cycle',
  ] as const)('rejects %s before provider execution', async (mode) => {
    const f = detailFixture();
    if (mode === 'missing-parent')
      f.document.assets[0]!.preparation!.parentId = 'parent-from-another-run';
    if (mode === 'missing-image') f.document.assets[1]!.image = null;
    if (mode === 'foreign-project-file') f.versions.findFirst.mockResolvedValue(null);
    if (mode === 'unavailable-file') f.files.findFirst.mockResolvedValue(null);
    if (mode === 'cycle')
      f.document.assets[1]!.preparation = {
        ...f.document.assets[0]!.preparation!,
        parentId: 'room',
      };
    await expect(
      freezeVideoRender(
        f.tx,
        'project',
        { document: f.document } as ProductionWorkspace,
        f.artifacts,
        'clip-a',
        settings,
        'controlled',
      ),
    ).rejects.toThrow();
  });
  it('rejects an actually mentioned missing image before provider work, while allowing pure text', async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          __dirname,
          '../../../../../../packages/contracts/fixtures/customized-video-plan-v2.json',
        ),
        'utf8',
      ),
    );
    const workspace = { document: fixture.document } as ProductionWorkspace;
    const artifacts = [
      {
        artifactKey: 'customized-video-clip:clip-a',
        freshness: 'CURRENT',
        payload: clipPayload(fixture.document, 'clip-a'),
      },
      {
        artifactKey: 'customized-clip-prompt:clip-a',
        freshness: 'CURRENT',
        payload: {
          target: { kind: 'CLIP', id: 'clip-a' },
          content: '@陶瓷杯的杯身特写。',
          assetIds: ['cup'],
        },
      },
    ] as unknown as WorkingArtifact[];
    const tx = {} as Prisma.TransactionClient;
    await expect(
      freezeVideoRender(tx, 'p', workspace, artifacts, 'clip-a', settings, 'controlled'),
    ).rejects.toThrow('参考图');
    artifacts[1]!.payload = {
      target: { kind: 'CLIP', id: 'clip-a' },
      content: '杯的特写。',
      assetIds: [],
    };
    expect(
      (await freezeVideoRender(tx, 'p', workspace, artifacts, 'clip-a', settings, 'controlled'))
        .input.references,
    ).toEqual([]);
  });
  it('accepts real pixel rounding, rejects duration, ratio and resolution mismatches', () => {
    expect(
      videoFileIssues(settings, 6, { durationSeconds: 6.041, width: 1280, height: 720 }),
    ).toBeNull();
    expect(
      videoFileIssues({ ...settings, resolution: '480p', ratio: '9:16' }, 6, {
        durationSeconds: 6.04,
        width: 496,
        height: 864,
      }),
    ).toBeNull();
    expect(
      videoFileIssues(settings, 6, { durationSeconds: 10, width: 1280, height: 720 }),
    ).toContain('时长');
    expect(
      videoFileIssues(settings, 6, { durationSeconds: 6, width: 1920, height: 1080 }),
    ).toContain('分辨率');
    expect(
      videoFileIssues(settings, 6, { durationSeconds: 6, width: 720, height: 1280 }),
    ).toContain('画幅');
  });
  it('keeps maximum-length clip identities inside the node-state key limit', () => {
    expect(renderSettingsNode('x'.repeat(200)).length).toBeLessThanOrEqual(160);
    expect(renderSettingsNode('x')).not.toBe(renderSettingsNode('y'));
  });
});
