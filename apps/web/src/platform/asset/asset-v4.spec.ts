import { describe, expect, it } from 'vitest';

import { projectMatchesSpace, typeLabel, typesForSpace, uploadAccept } from './asset-v4';

describe('V4 asset center mapping', () => {
  it('keeps the frozen type order for each workflow space', () => {
    expect(typesForSpace('FISSION_LOCAL_REPLACE').slice(0, 3)).toEqual([
      'SOURCE_VIDEO',
      'REPLACEMENT_CONFIGURATION',
      'ANALYSIS_QUALITY_REPORT',
    ]);
    expect(typesForSpace('CUSTOMIZED_VOICE_LIBRARY')).toEqual(['VOICE_PROFILE']);
  });

  it('restricts a project card to its declared workflow space', () => {
    const project = {
      id: 'project-1',
      name: '项目',
      description: null,
      status: 'ACTIVE' as const,
      createdAt: '',
      updatedAt: '',
      workflowSpaces: {
        effect: true,
        customized: false,
        fission: { clone: true, avatar: false, localReplace: false },
      },
    };
    expect(projectMatchesSpace(project, 'EFFECT')).toBe(true);
    expect(projectMatchesSpace(project, 'FISSION_CLONE')).toBe(true);
    expect(projectMatchesSpace(project, 'CUSTOMIZED_PROJECT')).toBe(false);
  });

  it('maps selected upload types to an appropriate file picker accept value', () => {
    expect(uploadAccept('REFERENCE_VIDEO')).toBe('video/*');
    expect(uploadAccept('VOICE_PROFILE')).toBe('audio/*');
    expect(uploadAccept('SUBTITLE')).toContain('.srt');
  });

  it('always renders a visible label for expanded V4 asset types', () => {
    expect(typeLabel('VIDEO_CONFIG')).toBe('视频配置');
    expect(typeLabel('INSIGHT_RESULT')).toBe('提炼结果');
  });
});
