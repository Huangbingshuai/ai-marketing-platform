import { randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// stdin is deliberately used instead of command arguments or environment variables.
// In a terminal, suppress password echo. Piped input supports secret-manager provisioning.
const terminal = Boolean(process.stdin.isTTY);
const reader = createInterface({ input: process.stdin, output: process.stdout, terminal });
const lines = reader[Symbol.asyncIterator]();
if (terminal) process.stdout.write('用户名: ');
const username = (await lines.next()).value?.trim();
if (terminal) {
  process.stdout.write('密码（输入隐藏）: ');
  reader._writeToOutput = () => {};
}
const password = (await lines.next()).value;
reader.close();
if (
  !username ||
  username.length > 120 ||
  !password ||
  password.length < 12 ||
  password.length > 256
)
  throw new Error('用户名不能为空，密码须为 12–256 个字符');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
const path = resolve(import.meta.dirname, '../../../.env');
let content = await readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
for (const [key, value] of Object.entries({ AUTH_USERNAME: username, AUTH_PASSWORD_HASH: hash })) {
  // Compose interpolates $ in unquoted values; preserve the literal scrypt hash.
  const serialized = key === 'AUTH_PASSWORD_HASH' ? `'${value}'` : value;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content)
    ? content.replace(pattern, () => `${key}=${serialized}`)
    : `${content.trimEnd()}\n${key}=${serialized}\n`;
}
await writeFile(path, content, { mode: 0o600 });
process.stdout.write('\n登录账号已写入本机 .env，密码未保存。\n');
