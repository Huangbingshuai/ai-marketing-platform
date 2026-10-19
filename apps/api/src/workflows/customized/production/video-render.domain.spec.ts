import { describe, expect, it } from 'vitest';
import { DEFAULT_CUSTOMIZED_VIDEO_RENDER_SETTINGS as settings } from '@ai-marketing/contracts';
import { videoFileIssues, renderSettingsNode, freezeVideoRender } from './video-render.domain';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProductionWorkspace } from '@ai-marketing/contracts';
import type { Prisma, WorkingArtifact } from '../../../generated/prisma/client';
import { clipPayload } from './video-production.domain';
describe('actual video validation', () => {
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
