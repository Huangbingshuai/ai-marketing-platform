import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export const guardAddress = (directory) => {
  const normalized = resolve(directory).replaceAll('\\', '/');
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? normalized.toLowerCase() : normalized)
    .digest('hex')
    .slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\amp-api-dev-${key}`
    : join(tmpdir(), `amp-api-dev-${key}.sock`);
};

// Kernel-owned IPC mutex: on Windows a crashed process cannot leave a stale lock file.
export async function acquireDevGuard(directory) {
  const server = createServer((socket) => socket.end('API dev already running\n'));
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(guardAddress(directory), resolveListen);
    });
    return { close: () => new Promise((done) => server.close(done)) };
  } catch (error) {
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
}

export const isWorkspaceWatcher = (command, directory) => {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  return (
    normalized.includes(`${resolve(directory).replaceAll('\\', '/').toLowerCase()}/`) &&
    /(?:nest\.js|nest)\b/.test(normalized) &&
    /start\s+--watch\b/.test(normalized)
  );
};

// Compatibility with existing direct Nest invocations. Discovery never kills a process.
export async function findWorkspaceWatchers(directory) {
  let processes;
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -match 'nest' -and $_.CommandLine -match 'start\\s+--watch'
    } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const { stdout } = await execute(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000 },
    );
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    processes = (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: item.ProcessId,
      command: item.CommandLine ?? '',
    }));
  } else {
    const { stdout } = await execute('ps', ['-eo', 'pid=,args='], { timeout: 10000 });
    processes = stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [, pid, command] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];
        return { pid: Number(pid), command: command ?? '' };
      });
  }
  return processes
    .filter((item) => item.pid !== process.pid && isWorkspaceWatcher(item.command, directory))
    .map((item) => item.pid);
}
