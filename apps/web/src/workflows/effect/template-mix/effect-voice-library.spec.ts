import { describe, expect, it } from 'vitest';
import source from './EffectVoiceLibrary.vue?raw';
import page from './EffectTemplateMixNodePage.vue?raw';

describe('voice library UI boundaries', () => {
  it('uses the audio pane and persists a preference without automatically generating', () => {
    expect(page).toContain('<EffectVoiceLibrary');
    expect(page).toContain(':selected-id="workspace.template.voiceProfileId"');
    const select = page.slice(
      page.indexOf('const selectVoiceProfile'),
      page.indexOf('const pauseForVoiceAudition'),
    );
    expect(select).toContain('workspace.value.template.voiceProfileId = id');
    expect(select).toContain('bump()');
    expect(select).not.toMatch(/createPackaging|requestJson|\.start\(/);
  });
  it('isolates scope changes, aborts polling and preserves uncertain submission keys', () => {
    expect(source).toContain('props.projectId, props.workflowRunId, props.templateId');
    expect(source).toContain('current !== generation');
    expect(source).toContain('onBeforeUnmount');
    expect(source).toContain('controller?.abort()');
    expect(source).toContain('pendingKeys.get(profile.id)');
    expect(source).toContain('isActive(cached)');
  });
  it('plays cached audio, reports real states and stops audition on main playback', () => {
    expect(source).toContain("cached?.status === 'COMPLETED'");
    expect(source).toMatch(/watch\(\s*\(\) => props\.playing/);
    expect(source).toContain('if (playing) stop()');
    expect(source).toContain('row.id}/cancel');
    expect(source).toContain('首次试听调用火山配音');
    expect(source).toContain('暂无已验证音色');
    expect(source).toContain('role="alert"');
    expect(source).toContain('aria-pressed');
    expect(source).not.toContain('openspeech.bytedance.com');
  });
});
