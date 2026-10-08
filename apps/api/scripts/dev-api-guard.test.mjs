import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { acquireDevGuard, guardAddress, isWorkspaceWatcher } from './dev-api-guard.mjs';

test('one workspace admits only one concurrent dev runner and releases on close', async () => {
  const scope = join(tmpdir(), `amp-guard-test-${randomUUID()}`);
  const guards = await Promise.all([acquireDevGuard(scope), acquireDevGuard(scope)]);
  assert.equal(guards.filter(Boolean).length, 1);
  await guards.find(Boolean).close();
  const next = await acquireDevGuard(scope);
  assert.ok(next);
  await next.close();
});

test('different workspaces are isolated', async () => {
  const a = join(tmpdir(), `amp-guard-test-${randomUUID()}`);
  const b = join(tmpdir(), `amp-guard-test-${randomUUID()}`);
  assert.notEqual(guardAddress(a), guardAddress(b));
  const first = await acquireDevGuard(a);
  const second = await acquireDevGuard(b);
  try {
    assert.ok(first);
    assert.ok(second);
  } finally {
    await first?.close();
    await second?.close();
  }
});

test('legacy watcher recognition excludes builds, other repos and application runtimes', () => {
  const root = join(tmpdir(), 'amp-watch-fixture', 'apps', 'api');
  assert.ok(
    isWorkspaceWatcher(
      `node "${root}/node_modules/@nestjs/cli/bin/nest.js" start --watch --path tsconfig.dev.json`,
      root,
    ),
  );
  assert.ok(
    isWorkspaceWatcher(
      `node "${root.replaceAll('/', '\\')}\\node_modules\\@nestjs\\cli\\bin\\nest.js" start --watch`,
      root,
    ),
  );
  assert.equal(
    isWorkspaceWatcher(`node ${root}/node_modules/@nestjs/cli/bin/nest.js build`, root),
    false,
  );
  assert.equal(isWorkspaceWatcher(`node ${root}/dist-dev/main`, root), false);
  assert.equal(
    isWorkspaceWatcher('node D:/other/node_modules/@nestjs/cli/bin/nest.js start --watch', root),
    false,
  );
  assert.equal(
    isWorkspaceWatcher(
      `node ${root}-other/node_modules/@nestjs/cli/bin/nest.js start --watch`,
      root,
    ),
    false,
  );
  assert.ok(
    isWorkspaceWatcher(
      `node D:/global/nest.js start --watch --path "${root}/tsconfig.dev.json"`,
      root,
    ),
  );
});
