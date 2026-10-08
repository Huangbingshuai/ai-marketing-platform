// Read-only instance diagnostics. Never print REDIS_URL, key names, values or credentials.
import { createClient } from 'redis';

const client = createClient({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  disableOfflineQueue: true,
  socket: { connectTimeout: 1000, reconnectStrategy: false },
});
client.on('error', () => undefined);
const deadline = setTimeout(() => {
  if (client.isOpen) client.destroy();
}, 5000);
try {
  await client.connect();
  const fields = Object.fromEntries(
    (await client.info()).split('\r\n').flatMap((line) => {
      const separator = line.indexOf(':');
      return separator < 0 ? [] : [[line.slice(0, separator), line.slice(separator + 1)]];
    }),
  );
  const allowed = [
    'redis_version',
    'redis_mode',
    'used_memory',
    'used_memory_peak',
    'maxmemory',
    'maxmemory_policy',
    'keyspace_hits',
    'keyspace_misses',
    'evicted_keys',
    'expired_keys',
  ];
  console.log(
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        scope: 'Redis instance totals, not application-only counters',
        ...Object.fromEntries(allowed.map((key) => [key, fields[key] ?? null])),
      },
      null,
      2,
    ),
  );
} catch {
  console.error('Redis diagnostics unavailable');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (client.isOpen) client.destroy();
}
