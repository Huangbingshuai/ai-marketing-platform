// Read-only benchmark: fetch persisted packaging data, never start paid tasks.
const [projectId, runId, mode] = process.argv.slice(2);
if (![projectId, runId].every((id) => /^[a-f0-9-]{36}$/.test(id ?? '')))
  throw new Error('Provide projectId and packagingRunId');
const response = await fetch(`http://localhost:${process.env.API_PORT ?? 3100}/api/projects/${projectId}/workflows/effect/template-mix/packaging-runs/${runId}`);
if (!response.ok) throw new Error(`Run HTTP ${response.status}`);
const { data: run } = await response.json();
const stats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { n: sorted.length, mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null, p10: q(.1), p50: q(.5), p95: q(.95) };
};
const rows = [], errors = [];
for (const item of run.items) {
  const cp = item.checkpoint ?? {}, timeline = item.sourceVisualTimeline;
  let cursor = 0;
  const windows = new Map((timeline?.slots ?? []).map((slot) => {
    const start = timeline.timelineStarts?.[slot.id] ?? cursor;
    cursor = start + slot.duration;
    return [slot.id, { start, end: cursor, duration: slot.duration, role: slot.role }];
  }));
  const seen = new Set();
  for (const line of cp.script ?? []) {
    const slot = windows.get(line.slotId), voice = cp.voices?.[line.id];
    if (!slot || seen.has(line.slotId)) errors.push({ item: item.name, line: line.id, reason: 'unknown/duplicate slot' });
    seen.add(line.slotId);
    if (!slot || !voice) continue;
    const caption = cp.captions?.find((c) => c.slotId === line.slotId || c.id === line.id);
    const outside = (start, end) => start < slot.start - .001 || end > slot.end + .001;
    if (outside(line.start, line.end) || outside(voice.start, voice.start + voice.duration) || (caption && outside(caption.start, caption.end)))
      errors.push({ item: item.name, line: line.id, reason: 'slot boundary' });
    rows.push({ name: item.name, slotId: line.slotId, role: slot.role, text: line.text, slotSeconds: slot.duration, audioSeconds: voice.duration, utilization: voice.duration / slot.duration, characters: line.text.trim().length, fileObjectId: voice.fileObjectId, metrics: cp.narrationMetrics?.[line.slotId] });
  }
  if (item.status === 'COMPLETED' && (seen.size !== windows.size || Object.keys(cp.voices ?? {}).length !== windows.size || cp.captions?.length !== windows.size))
    errors.push({ item: item.name, reason: 'completed slot/script/voice/caption count' });
}
const durations = [...new Set(rows.map((r) => r.slotSeconds))].sort((a, b) => a - b);
const summary = {
  observedAt: new Date().toISOString(), runId, status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, completedAt: run.completedAt,
  counts: run.counts, execution: { ...run.execution, shards: undefined },
  failed: run.items.filter((i) => i.status === 'FAILED').map((i) => ({ name: i.name, stage: i.stage, error: i.errorMessage, retries: i.checkpoint?.automaticRetries })),
  stale: run.items.filter((i) => i.stale).map((i) => i.name),
  retryItems: run.items.filter((i) => i.checkpoint?.automaticRetries).map((i) => ({ name: i.name, retries: i.checkpoint.automaticRetries })),
  narration: durations.map((duration) => {
    const group = rows.filter((r) => r.slotSeconds === duration);
    return { slotSeconds: duration, characters: stats(group.map((r) => r.characters)), audioSeconds: stats(group.map((r) => r.audioSeconds)), utilization: stats(group.map((r) => r.utilization)), belowHalf: group.filter((r) => r.utilization < .5).length };
  }), boundaryErrors: errors,
};
if (mode === '--samples') summary.samples = rows.slice(0, 30);
if (mode === '--all') summary.samples = rows;
console.log(JSON.stringify(summary, null, 2));
