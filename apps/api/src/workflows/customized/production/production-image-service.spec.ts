import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AssetService } from '../../../platform/asset/asset.service';
import type { StoragePort } from '../../../platform/file/storage.port';
import { SKIP_RESPONSE_ENVELOPE } from '../../../common/raw-response.decorator';
import { ProductionWorkerController } from './production.controller';
import type { ProductionRepository } from './production.repository';
import { ProductionImageService } from './production-image.service';

describe('protected image references', () => {
  it('imports a reference in the selected production run with validated image metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'customized-image-reference-'));
    try {
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      );
      const path = join(directory, 'reference.png');
      await writeFile(path, bytes);
      const repository = { workspace: vi.fn().mockResolvedValue({}) };
      const asset = { id: 'reference', currentVersion: 1 };
      const assets = { importMany: vi.fn().mockResolvedValue([asset]) };
      const service = new ProductionImageService(
        repository as unknown as ProductionRepository,
        {} as StoragePort,
        assets as unknown as AssetService,
      );
      const result = await service.uploadReference('project', 'run', {
        path,
        originalname: 'reference.png',
        mimetype: 'application/octet-stream',
        size: bytes.length,
      });
      expect(result).toBe(asset);
      expect(repository.workspace).toHaveBeenCalledTimes(2);
      expect(repository.workspace).toHaveBeenCalledWith('project', 'run');
      expect(assets.importMany).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({
          workflow: 'CUSTOMIZED',
          space: 'CUSTOMIZED_PROJECT',
          sourceRunId: 'run',
          sourceNode: 'SHOT_PROMPT',
        }),
        [expect.objectContaining({ mimetype: 'image/png', size: bytes.length })],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects an unavailable run before importing any reference', async () => {
    const repository = { workspace: vi.fn().mockRejectedValue(new Error('wrong run')) };
    const assets = { importMany: vi.fn() };
    const service = new ProductionImageService(
      repository as unknown as ProductionRepository,
      {} as StoragePort,
      assets as unknown as AssetService,
    );
    await expect(service.uploadReference('other', 'run')).rejects.toThrow('wrong run');
    expect(assets.importMany).not.toHaveBeenCalled();
  });
  it('returns raw image bytes after checking the exact task lease and version', async () => {
    const bytes = Buffer.from('controlled bytes');
    const repository = {
      imageReferenceScope: vi
        .fn()
        .mockResolvedValue({ storageKey: 'test', mimeType: 'image/png', sizeBytes: bytes.length }),
    };
    const storage = {
      open: vi.fn().mockResolvedValue({ stream: Readable.from(bytes), sizeBytes: bytes.length }),
    };
    const service = new ProductionImageService(
      repository as unknown as ProductionRepository,
      storage as unknown as StoragePort,
      {} as AssetService,
    );
    const result = await service.reference('project', 'task', 'attempt', 'asset', 2);
    expect(repository.imageReferenceScope).toHaveBeenCalledWith(
      'project',
      'task',
      'attempt',
      'asset',
      2,
    );
    expect(result.getHeaders().type).toBe('image/png');
    const chunks: Buffer[] = [];
    for await (const chunk of result.getStream()) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(
      Reflect.getMetadata(SKIP_RESPONSE_ENVELOPE, ProductionWorkerController.prototype.reference),
    ).toBe(true);
  });
  it('does not open a file rejected by the task scope', async () => {
    const repository = { imageReferenceScope: vi.fn().mockRejectedValue(new Error('wrong scope')) };
    const storage = { open: vi.fn() };
    const service = new ProductionImageService(
      repository as unknown as ProductionRepository,
      storage as unknown as StoragePort,
      {} as AssetService,
    );
    await expect(service.reference('other', 'task', 'old-attempt', 'asset', 2)).rejects.toThrow(
      'wrong scope',
    );
    expect(storage.open).not.toHaveBeenCalled();
  });
});
