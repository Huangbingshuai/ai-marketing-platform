import type { VideoClip, VideoPlan, VideoShot } from './customized-video-plan';
import { videoClipMs, videoClipShots, videoClipAssetIds } from './customized-video-plan';

const joined = (values: string[], separator = '\n\n') =>
  [...new Set(values.filter(Boolean))].join(separator);

/** A complete storyboard editing unit. Historical rows are projected without mutating their source. */
export function videoTaskShot(plan: VideoPlan, clip: VideoClip): VideoShot | undefined {
  const shots = videoClipShots(plan, clip),
    first = shots[0],
    last = shots.at(-1);
  if (!first || !last) return undefined;
  return {
    ...first,
    title: clip.title,
    durationSeconds: videoClipMs(plan, clip) / 1000,
    visual: shots
      .map((s) => s.visual)
      .filter(Boolean)
      .join('\n\n'),
    shotType: joined(
      shots.map((s) => s.shotType),
      '；',
    ),
    cameraMovement: joined(
      shots.map((s) => s.cameraMovement),
      '；',
    ),
    information: joined(shots.map((s) => s.information)),
    framing: joined(shots.map((s) => s.framing)),
    angle: joined(
      shots.map((s) => s.angle),
      '；',
    ),
    audio: joined(
      shots.map((s) => s.audio),
      '；',
    ),
    atmosphere: joined(
      shots.map((s) => s.atmosphere),
      '；',
    ),
    startState: first.startState,
    endState: last.endState,
    sourceEventIds: [...new Set(shots.flatMap((s) => s.sourceEventIds))],
    bindings: videoClipAssetIds(plan, clip).map((assetId) => ({
      assetId,
      description: joined(
        shots.flatMap((s) =>
          s.bindings.filter((b) => b.assetId === assetId).map((b) => b.description),
        ),
        '；',
      ),
    })),
  };
}

/** Explicit draft edit only: one task, one storyboard. Preserve sources and rebase authored cue times. */
export function mergeVideoTaskShots(plan: VideoPlan, clipId: string): VideoPlan {
  const value = JSON.parse(JSON.stringify(plan)) as VideoPlan,
    clip = value.clips.find((c) => c.id === clipId);
  if (!clip) return value;
  if (clip.shotIds.length === 1) {
    // The task's displayed name is authoritative when editing its description.
    // Older/newly generated rows may retain a different internal shot title.
    const existing = value.shots.find((s) => s.id === clip.shotIds[0]);
    if (existing) existing.title = clip.title;
    return value;
  }
  const task = videoTaskShot(value, clip);
  if (!task) return value;
  const old = videoClipShots(value, clip),
    offsets = new Map<string, number>();
  let offset = 0;
  for (const shot of old) {
    offsets.set(shot.id, offset);
    offset += Math.round(shot.durationSeconds * 1000);
  }
  const ids = new Set(clip.shotIds);
  value.shots = value.shots.flatMap((s) => (s.id === task.id ? [task] : ids.has(s.id) ? [] : [s]));
  for (const cue of value.cues)
    cue.parts = cue.parts.map((p) =>
      offsets.has(p.shotId)
        ? {
            ...p,
            shotId: task.id,
            startMs: p.startMs + offsets.get(p.shotId)!,
            endMs: p.endMs + offsets.get(p.shotId)!,
          }
        : p,
    );
  clip.shotIds = [task.id];
  clip.startState = task.startState;
  clip.endState = task.endState;
  return value;
}
