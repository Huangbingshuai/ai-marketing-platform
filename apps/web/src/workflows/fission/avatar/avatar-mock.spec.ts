import { describe, expect, it } from 'vitest';
import {
  clone,
  completeSubtitles,
  completeVideo,
  createDemo,
  isCompositionStale,
  isSourceStale,
  restoreDemo,
  sourceFingerprint,
  splitSubtitle,
  storageKey,
  parseSubtitleFile,
} from './avatar-mock';
describe('数字人口播隔离 Mock 工作副本', () => {
  it('导入 SRT、VTT 与 ASS，过滤损坏时间码并保留字幕文本', () => {
    expect(parseSubtitleFile('1\n00:00:01,000 --> 00:00:02,500\n示例字幕\n')[0]?.duration).toBe(
      1.5,
    );
    expect(parseSubtitleFile('WEBVTT\n\n00:01.000 --> 00:02.000\n<b>示例字幕</b>\n')[0]?.text).toBe(
      '示例字幕',
    );
    expect(
      parseSubtitleFile(
        '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好\\N世界',
      )[0]?.text,
    ).toBe('你好\n世界');
    expect(parseSubtitleFile('1\n00:00:02,000 --> 00:00:01,000\n无效字幕')).toEqual([]);
  });
  it('按项目和数字人 Run 隔离，拒绝跨项目和损坏草稿', () => {
    const draft = createDemo('project-a');
    completeVideo(draft);
    expect(storageKey('project-a')).not.toBe(storageKey('project-b'));
    expect(storageKey('project-a')).toContain('FISSION_AVATAR');
    expect(restoreDemo(JSON.stringify(draft), 'project-b')).toBeNull();
    expect(restoreDemo('{broken', 'project-a')).toBeNull();
    const restored = restoreDemo(JSON.stringify(draft), 'project-a');
    expect(restored).toEqual(draft);
    draft.tracks.video[0]!.duration = -1;
    expect(restoreDemo(JSON.stringify(draft), 'project-a')).toBeNull();
  });
  it('导航不推进来源，生成后分别建立视频与音频，字幕独立生成', () => {
    const draft = createDemo('a');
    const source = sourceFingerprint(draft);
    draft.tool = 'copy';
    expect(sourceFingerprint(draft)).toBe(source);
    completeVideo(draft);
    expect(draft.tracks.video).toHaveLength(1);
    expect(draft.tracks.audio).toHaveLength(5);
    expect(draft.tracks.subtitle).toHaveLength(0);
    completeSubtitles(draft);
    expect(draft.tracks.subtitle).toHaveLength(5);
    const last = draft.tracks.audio.at(-1)!;
    expect(last.start + last.duration).toBe(draft.tracks.video[0]!.duration);
  });
  it('背景变化保留口播与音轨，只使合成待更新；两轮文案变化均检测到', () => {
    const draft = createDemo('a');
    completeVideo(draft);
    const audio = clone(draft.tracks.audio);
    draft.backgroundId = 'scene-live';
    expect(isSourceStale(draft)).toBe(false);
    expect(isCompositionStale(draft)).toBe(true);
    expect(draft.tracks.audio).toEqual(audio);
    draft.copy += '欢迎品尝。';
    expect(isSourceStale(draft)).toBe(true);
    completeVideo(draft);
    expect(isSourceStale(draft)).toBe(false);
    draft.copy += '一起分享。';
    expect(isSourceStale(draft)).toBe(true);
  });
  it('字幕样式彼此独立，分割保留总时长且不改兄弟轨道', () => {
    const draft = createDemo('a');
    completeVideo(draft);
    completeSubtitles(draft);
    const first = draft.tracks.subtitle[0]!;
    const before = clone(draft.tracks.audio);
    const length = first.duration;
    first.style!.fontSize = 48;
    expect(draft.tracks.subtitle[1]!.style!.fontSize).toBe(34);
    expect(splitSubtitle(draft.tracks.subtitle, first.id, first.start + length / 2)).toBe(true);
    expect(draft.tracks.subtitle).toHaveLength(6);
    expect(draft.tracks.subtitle[0]!.duration + draft.tracks.subtitle[1]!.duration).toBe(length);
    expect(draft.tracks.audio).toEqual(before);
    expect(splitSubtitle(draft.tracks.subtitle, first.id, first.start)).toBe(false);
  });
  it('重新生成覆盖当前演示结果且清空旧字幕，其他项目保持原状', () => {
    const a = createDemo('a'),
      b = createDemo('b');
    completeVideo(a);
    completeSubtitles(a);
    completeVideo(b);
    const original = clone(b);
    a.copy = '新的口播内容。';
    completeVideo(a);
    expect(a.tracks.video).toHaveLength(1);
    expect(a.tracks.audio).toHaveLength(1);
    expect(a.tracks.subtitle).toHaveLength(0);
    expect(b).toEqual(original);
  });
});
