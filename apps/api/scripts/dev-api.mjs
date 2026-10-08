import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDevGuard, findWorkspaceWatchers } from './dev-api-guard.mjs';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = await acquireDevGuard(directory);
if (!guard) {
  console.log('此工作区已有 API 开发进程，复用现有服务。');
} else {
  let child;
  try {
    const watchers = await findWorkspaceWatchers(directory);
    if (watchers.length) {
      console.log(
        `此工作区已有直接启动的 Nest watcher（PID ${watchers.join(', ')}），未重复启动。`,
      );
      await guard.close();
    } else {
      // Preserve the workspace path in argv for legacy/orphan process discovery.
      const cli = resolve(directory, 'node_modules/@nestjs/cli/bin/nest.js');
      child = spawn(process.execPath, [cli, 'start', '--watch', '--path', 'tsconfig.dev.json'], {
        cwd: directory,
        stdio: 'inherit',
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let stopping = false;
      const stop = () => {
        if (stopping || !child.pid) return;
        stopping = true;
        // Nest starts its runtime through a shell. Stop the owned subtree as well.
        if (process.platform === 'win32') {
          const termination = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          termination.once('error', () => child.kill('SIGTERM'));
        } else {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            child.kill('SIGTERM');
          }
        }
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      child.once('error', async (error) => {
        console.error(`API 开发进程启动失败：${error.code ?? error.name}`);
        process.exitCode = 1;
        await guard.close();
      });
      child.once('exit', async (code) => {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
        process.exitCode = code ?? 0;
        await guard.close();
      });
    }
  } catch (error) {
    console.error(`API 开发启动检查失败：${error.code ?? error.name}`);
    process.exitCode = 1;
    await guard.close();
  }
}
