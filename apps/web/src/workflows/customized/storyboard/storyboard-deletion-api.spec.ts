import { beforeEach, expect, it, vi } from 'vitest';
import { storyboardApi } from './storyboard.api';
import { requestJson } from '../../../api/http-client';

vi.mock('../../../api/http-client', () => ({ requestJson: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it('sends permanent deletion with the project, script identity, Run and latest revision', async () => {
  const result = {
    scriptId: 'script',
    removedScriptIds: ['script'],
    removedRunIds: ['child', 'grandchild'],
    fallbackRunId: 'root',
    activeRunChanged: true,
  };
  vi.mocked(requestJson).mockResolvedValue({ data: result });
  const signal = new AbortController().signal;
  expect(await storyboardApi.remove('project', 'script', 'child', 7, signal)).toEqual(result);
  expect(requestJson).toHaveBeenCalledWith(
    '/projects/project/workflows/customized/storyboard/scripts/script',
    { method: 'DELETE', body: { workflowRunId: 'child', expectedRevision: 7 }, signal },
  );
});
