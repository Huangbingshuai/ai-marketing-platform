import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const shell =
  process.platform === 'win32'
    ? ['D:/develop/Git/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'].find(existsSync)
    : '/bin/sh';
const script = resolve(
  'workers/shared/customized-production-runtime/scripts/check-production-runtime.sh',
);
const unix = (p) =>
  process.platform === 'win32'
    ? p.replace(/^([A-Za-z]):[\\/]/, (_m, d) => `/${d.toLowerCase()}/`).replaceAll('\\', '/')
    : p;
for (const [role, tools, expected, message] of [
  ['api', { ffprobe: 0 }, 0, 'ffprobe OK'],
  ['customized-production', { ffprobe: 0 }, 1, 'ffmpeg MISSING'],
  ['customized-production', { ffmpeg: 0, ffprobe: 0 }, 0, 'ffmpeg OK'],
  ['customized-production', { ffmpeg: 7, ffprobe: 0 }, 1, 'ffmpeg UNUSABLE'],
  ['invalid', {}, 2, 'expected api'],
])
  test(`runtime smoke ${role} ${message}`, { skip: !shell }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-probe-'));
    try {
      for (const [name, status] of Object.entries(tools))
        await writeFile(join(directory, name), `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 });
      const setup =
        'for tool in "$3"/*; do if [ -f "$tool" ]; then /bin/chmod +x "$tool"; fi; done; export PATH="$3"; exec /bin/sh "$1" "$2"';
      const result = spawnSync(
        shell,
        ['-c', setup, 'runtime-smoke', unix(script), role, unix(directory)],
        { encoding: 'utf8', timeout: 10000 },
      );
      assert.equal(result.status, expected, result.stderr);
      assert.match(result.stdout + result.stderr, new RegExp(message));
    } finally {
      const target = resolve(directory),
        parent = resolve(tmpdir()) + sep;
      assert.ok(target.startsWith(parent) && basename(target).startsWith('runtime-probe-'));
      await rm(target, { recursive: true, force: true });
    }
  });
test('both canonical Dockerfiles install/probe their required runtime without starting services', () => {
  const api = readFileSync('deploy/Dockerfile.api', 'utf8'),
    worker = readFileSync('workers/customized-production/Dockerfile', 'utf8');
  assert.match(api, /install[^\n]*ffmpeg/);
  assert.match(api, /RUN[^\n]*check-production-runtime api/);
  assert.match(worker, /RUN[^\n]*check-production-runtime customized-production/);
  for (const source of [api, worker])
    assert.match(
      source,
      /COPY[^\n]*scripts\/check-production-runtime\.sh \/usr\/local\/bin\/check-production-runtime/,
    );
});
test('API bootstrap uses bundled trusted PEM roots and preserves an existing bundle', async () => {
  const source = readFileSync('deploy/Dockerfile.api', 'utf8');
  const code = source.match(/RUN node -e '([^']+)'/)[1];
  assert.match(code, /tls\.rootCertificates/);
  assert.doesNotMatch(
    source,
    /allow-unauthenticated|Verify-Peer=false|trusted=yes|NODE_TLS_REJECT_UNAUTHORIZED/,
  );
  const directory = await mkdtemp(join(tmpdir(), 'runtime-probe-'));
  try {
    const bundle = join(directory, 'roots.pem');
    const controlled = code
      .replaceAll('"/etc/ssl/certs/ca-certificates.crt"', JSON.stringify(bundle))
      .replaceAll('"/etc/ssl/certs"', JSON.stringify(directory));
    assert.ok(!controlled.includes('/etc/ssl/certs'));
    assert.equal(spawnSync(process.execPath, ['-e', controlled]).status, 0);
    assert.match(await readFile(bundle, 'utf8'), /-----BEGIN CERTIFICATE-----/);
    await writeFile(bundle, 'existing trusted bundle');
    assert.equal(spawnSync(process.execPath, ['-e', controlled]).status, 0);
    assert.equal(await readFile(bundle, 'utf8'), 'existing trusted bundle');
  } finally {
    const target = resolve(directory);
    assert.ok(
      target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('runtime-probe-'),
    );
    await rm(target, { recursive: true, force: true });
  }
});
