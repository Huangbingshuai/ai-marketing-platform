import { isProductionDocument, isVideoDocument } from '@ai-marketing/contracts';

/** Only the confirmed plan defines the current task set; drafts and historical
 * tombstones must not make an otherwise current video node stale. Read-only. */
export function currentCustomizedVideoArtifacts<
  T extends { artifactKey: string; payload: unknown },
>(artifacts: T[]): T[] {
  const payload = artifacts.find((a) => a.artifactKey === 'customized-video-plan')?.payload;
  if (!isProductionDocument(payload) || !isVideoDocument(payload)) return artifacts;
  const shots = new Set(payload.videoPlan.shots.map((s) => s.id));
  const clips = new Set(payload.videoPlan.clips.map((c) => c.id));
  const scopes: [string, Set<string>][] = [
    ['customized-shot:', shots],
    ['customized-shot-prompt:', shots],
    ['customized-video-clip:', clips],
    ['customized-clip-prompt:', clips],
    ['customized-clip-video:', clips],
  ];
  return artifacts.filter((a) => {
    const scope = scopes.find(([prefix]) => a.artifactKey.startsWith(prefix));
    return !scope || scope[1].has(a.artifactKey.slice(scope[0].length));
  });
}
