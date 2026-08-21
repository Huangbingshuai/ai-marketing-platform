import type { Project } from '@ai-marketing/contracts';
import { describe, expect, it } from 'vitest';

import {
  presentProjectBinding,
  projectCreationScope,
  resolveBoundProjectId,
} from './project-context';

const project = {
  id: 'project-a',
  name: '夏季投放',
  client: '广味食品',
} as Project;

describe('project binding context', () => {
  it('maps every new project to the workflow selected when it was created', () => {
    expect(projectCreationScope('EFFECT')).toEqual({ workflow: 'EFFECT', space: 'EFFECT' });
    expect(projectCreationScope('CUSTOMIZED')).toEqual({
      workflow: 'CUSTOMIZED',
      space: 'CUSTOMIZED_PROJECT',
    });
    expect(projectCreationScope('FISSION')).toEqual({
      workflow: 'FISSION',
      space: 'FISSION_CLONE',
    });
  });

  it('only restores an explicit valid binding and never selects the first project implicitly', () => {
    expect(resolveBoundProjectId([project], '', '')).toBe('');
    expect(resolveBoundProjectId([project], '', 'project-a')).toBe('project-a');
    expect(resolveBoundProjectId([project], '', 'missing-project')).toBe('');
  });

  it('distinguishes bound, unbound, empty, loading and error states', () => {
    expect(presentProjectBinding(project, [project], false, '')).toEqual({
      label: '广味食品 · 夏季投放',
      state: 'bound',
    });
    expect(presentProjectBinding(null, [project], false, '')).toEqual({
      label: '空项目',
      state: 'unbound',
    });
    expect(presentProjectBinding(null, [], false, '')).toEqual({
      label: '尚未创建项目',
      state: 'empty',
    });
    expect(presentProjectBinding(null, [], true, '')).toEqual({
      label: '正在加载项目…',
      state: 'loading',
    });
    expect(presentProjectBinding(null, [], false, '加载失败')).toEqual({
      label: '项目状态不可用',
      state: 'error',
    });
  });
});
