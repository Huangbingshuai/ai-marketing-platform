import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseEnv } from 'node:util';

test('login provisioning preserves a literal Compose-safe hash and unrelated configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'login-config-test-'));
  try {
    const scripts = join(root, 'apps/api/scripts');
    await mkdir(scripts, { recursive: true });
    const script = join(scripts, 'configure-login.mjs');
    await writeFile(script, await readFile(new URL('./configure-login.mjs', import.meta.url)));
    await writeFile(
      join(root, '.env'),
      'API_PORT=3100\nAUTH_USERNAME=old\nAUTH_PASSWORD_HASH=old\n',
    );
    const password = 'test-only-password-123';
    const result = spawnSync(process.execPath, [script], {
      input: `test-operator\n${password}\n`,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    const content = await readFile(join(root, '.env'), 'utf8');
    assert.match(content, /^AUTH_PASSWORD_HASH='scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}'$/m);
    const env = parseEnv(content);
    assert.equal(env.API_PORT, '3100');
    assert.equal(env.AUTH_USERNAME, 'test-operator');
    const [, salt, digest] = env.AUTH_PASSWORD_HASH.split('$');
    assert.equal(digest, scryptSync(password, salt, 64).toString('hex'));
    assert.ok(!content.includes(password));
    assert.ok(!result.stdout.includes(password));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
