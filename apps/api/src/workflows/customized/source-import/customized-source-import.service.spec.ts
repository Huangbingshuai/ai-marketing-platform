import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizedSourceImportService } from './customized-source-import.service';

describe('customized upload scope and cleanup', () => {
  let root: string;
  const guard = vi.fn();
  const importMany = vi.fn();
  const service = new CustomizedSourceImportService(
    { importMany } as never,
    { assertCustomizedImportEditable: guard } as never,
  );
  beforeEach(async () => {
    vi.resetAllMocks();
    guard.mockResolvedValue({ id: 'run' });
    importMany.mockResolvedValue([{ id: 'asset', currentVersion: 1 }]);
    root = await mkdtemp(join(tmpdir(), 'customized-upload-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const file = async () => {
    const path = join(root, 'brief.txt');
    await writeFile(path, 'brief');
    return { path, originalname: 'brief.txt', mimetype: 'text/plain', size: 5 };
  };
  it('uses shared assets with a content identity and transactional edit guard', async () => {
    const upload = await file();
    expect(await service.upload('project', 'run', 'BRIEF', upload)).toMatchObject({ id: 'asset' });
    expect(importMany).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({
        workflow: 'CUSTOMIZED',
        space: 'CUSTOMIZED_PROJECT',
        editableCustomizedRunId: 'run',
        contentIdentity: 'customized-source-v1:BRIEF',
      }),
      [upload],
    );
    expect(guard).toHaveBeenCalledTimes(2);
    await expect(stat(upload.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a closed/read-only/foreign Run before storing and removes its temporary file', async () => {
    guard.mockRejectedValue(new Error('NOT_EDITABLE'));
    const upload = await file();
    await expect(service.upload('project', 'run', 'BRIEF', upload)).rejects.toThrow('NOT_EDITABLE');
    expect(importMany).not.toHaveBeenCalled();
    await expect(stat(upload.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('rejects a late upload result after edit cancellation without attaching it to a new Run', async () => {
    guard.mockResolvedValueOnce({ id: 'run' }).mockRejectedValueOnce(new Error('RUN_CHANGED'));
    await expect(service.upload('project', 'run', 'BRIEF', await file())).rejects.toThrow(
      'RUN_CHANGED',
    );
    expect(importMany).toHaveBeenCalledTimes(1);
  });
  it('retains no temporary files after storage or validation failures', async () => {
    const upload = await file();
    importMany.mockRejectedValue(new Error('STORAGE_FAILED'));
    await expect(service.upload('project', 'run', 'BRIEF', upload)).rejects.toThrow(
      'STORAGE_FAILED',
    );
    await expect(stat(upload.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const wrongArea = await file();
    await expect(service.upload('project', 'run', 'VISUAL_REFERENCE', wrongArea)).rejects.toThrow(
      '资料类型',
    );
    await expect(stat(wrongArea.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
