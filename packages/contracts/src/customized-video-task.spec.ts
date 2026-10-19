import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { videoTaskShot, mergeVideoTaskShots } from './customized-video-task';
import { isVideoPlan, videoClipProjection, type VideoPlan } from './customized-video-plan';

const fixture = (): VideoPlan =>
  JSON.parse(readFileSync(resolve(__dirname, '../fixtures/customized-video-plan-v2.json'), 'utf8'))
    .document.videoPlan;
describe('one storyboard per video task', () => {
  it('keeps the visible task name when editing a single-row task with a different internal title', () => {
    const plan = fixture(),
      result = mergeVideoTaskShots(plan, 'clip-b');
    expect(result.shots.find((s) => s.id === 'shot-c')!.title).toBe(plan.clips[1]!.title);
    expect(result.clips[1]!.title).toBe(plan.clips[1]!.title);
    expect(plan.shots.find((s) => s.id === 'shot-c')!.title).toBe('shot-c');
  });
  it('projects historical content without mutating or losing either visual', () => {
    const plan = fixture(),
      before = JSON.stringify(plan);
    plan.shots[1]!.visual = '第二段产品细节';
    const copy = JSON.stringify(plan),
      task = videoTaskShot(plan, plan.clips[0]!)!;
    expect(task.visual).toBe('手持陶瓷杯\n\n第二段产品细节');
    expect(task.durationSeconds).toBe(10);
    expect(task.bindings.map((b) => b.assetId)).toEqual(['cup', 'room']);
    expect(JSON.stringify(plan)).toBe(copy);
    expect(before).not.toBe(copy);
    expect(videoClipProjection(plan, plan.clips[0]!).visual).not.toContain('【镜头');
  });
  it('rebases cue timings exactly and leaves other tasks, sources and authored text unchanged', () => {
    const plan = fixture(),
      before = JSON.stringify(plan),
      result = mergeVideoTaskShots(plan, 'clip-a');
    expect(result.clips[0]!.shotIds).toEqual(['shot-a']);
    expect(result.shots.map((s) => s.id)).toEqual(['shot-a', 'shot-c']);
    expect(result.shots[0]!.durationSeconds).toBe(10);
    for (let i = 0; i < plan.cues.length; i++) {
      const old = plan.cues[i]!,
        updated = result.cues[i]!;
      expect({ ...updated, parts: [] }).toEqual({ ...old, parts: [] });
      expect(updated.parts).toEqual(
        old.parts.map((p) =>
          p.shotId === 'shot-b'
            ? { ...p, shotId: 'shot-a', startMs: p.startMs + 5000, endMs: p.endMs + 5000 }
            : p,
        ),
      );
    }
    expect(result.sourceUnits).toEqual(plan.sourceUnits);
    expect(result.sources).toEqual(plan.sources);
    expect(result.clips[1]).toEqual(plan.clips[1]);
    expect(result.shots[1]).toEqual(plan.shots[2]);
    expect(isVideoPlan(result)).toBe(true);
    expect(mergeVideoTaskShots(result, 'clip-a')).toEqual(result);
    expect(JSON.stringify(plan)).toBe(before);
  });
});
