// Read-only acceptance check for persisted packaging audio; never invokes providers.
const [projectId, runId] = process.argv.slice(2);
if (![projectId, runId].every((id) => /^[a-f0-9-]{36}$/.test(id ?? '')))
  throw new Error('Provide projectId and packagingRunId');
const base = `http://localhost:${process.env.API_PORT ?? 3100}/api/projects/${projectId}`;
const response = await fetch(`${base}/workflows/effect/template-mix/packaging-runs/${runId}`);
if (!response.ok) throw new Error(`Run HTTP ${response.status}`);
const { data: run } = await response.json();
const completed = run.items.filter((item) => item.status === 'COMPLETED');
const files = completed.flatMap((item) => [
  ...Object.values(item.checkpoint.voices ?? {}).map((audio) => ({ ...audio, role: 'VOICE' })),
  ...(item.checkpoint.music ? [{ ...item.checkpoint.music, role: 'MUSIC' }] : []),
]);
const errors = [];
let checked = 0;
async function check(audio) {
  const result = await fetch(`${base}/file-objects/${audio.fileObjectId}/content`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!result.ok) throw new Error(`HTTP ${result.status}`);
  const wav = Buffer.from(await result.arrayBuffer());
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Not a WAV file');
  let fmt, data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const kind = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    if (offset + 8 + length > wav.length) throw new Error('Truncated WAV chunk');
    if (kind === 'fmt ') fmt = wav.subarray(offset + 8, offset + 8 + length);
    if (kind === 'data') data = wav.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + (length % 2);
  }
  if (!fmt || !data?.length || fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(14) !== 16)
    throw new Error('Missing/unsupported PCM audio');
  const duration = data.length / fmt.readUInt32LE(8);
  if (!Number.isFinite(duration) || Math.abs(duration - audio.duration) > 0.05)
    throw new Error('Measured duration mismatch');
  let peak = 0;
  for (let offset = 0; offset + 2 <= data.length; offset += 2)
    peak = Math.max(peak, Math.abs(data.readInt16LE(offset)));
  if (peak === 0) throw new Error('Silent PCM');
  checked++;
}
let cursor = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (cursor < files.length) {
      const audio = files[cursor++];
      try {
        await check(audio);
      } catch (error) {
        errors.push({ fileObjectId: audio.fileObjectId, role: audio.role, reason: error.message });
      }
    }
  }),
);
console.log(
  JSON.stringify({
    runId,
    status: run.status,
    completed: completed.length,
    voices: files.filter((a) => a.role === 'VOICE').length,
    music: files.filter((a) => a.role === 'MUSIC').length,
    captions: completed.reduce((sum, item) => sum + (item.checkpoint.captions?.length ?? 0), 0),
    checked,
    errors,
  }),
);
if (errors.length) process.exitCode = 1;
