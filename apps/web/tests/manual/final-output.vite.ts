import { fileURLToPath } from 'node:url';
import { createReadStream, statSync } from 'node:fs';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Opt-in isolated browser fixture. No proxy, database access, queue or supplier calls.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('/api') },
  resolve: {
    alias: {
      '@ai-marketing/contracts': fileURLToPath(
        new URL('../../../../packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  optimizeDeps: { exclude: ['@ai-marketing/contracts'] },
  plugins: [
    vue(),
    {
      name: 'isolated-output-fixture',
      configureServer(server) {
        const recovered = new Set<string>();
        const cancelled = new Set<string>();
        const exported = new Set<string>();
        const outputSettings = new Map<string, { resolution: string; frameRate: number }>();
        const demoNames = [
          '开场产品展示',
          '包装细节特写',
          '使用动作演示',
          '质地近景镜头',
          '生活场景切换',
          '多角度产品展示',
          '使用前准备',
          '镜头缓慢推进',
          '桌面陈列画面',
          '产品收尾镜头',
          '创意版本 A',
          '创意版本 B',
        ];
        const demoDurations = [12.6, 15, 11.8, 14.2, 16.4, 13.1, 15.7, 12, 17.2, 14.8, 13.6, 16];
        server.middlewares.use((req, res, next) => {
          const url = req.url ?? '';
          if (!url.startsWith('/api/')) return next();
          let mode = url.match(/projects\/fixture-([^/]+)/)?.[1];
          if (!mode) {
            res.statusCode = 404;
            return res.end();
          }
          if (url.includes('/file-objects/')) {
            const path =
              process.env.OUTPUT_FIXTURE_VIDEO ??
              fileURLToPath(new URL('./fixtures/effect-final-output-demo.mp4', import.meta.url));
            const size = statSync(path).size;
            const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
            const start = range ? Number(range[1]) : 0,
              end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            res.statusCode = range ? 206 : 200;
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', end - start + 1);
            if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            if (url.includes('download=true'))
              res.setHeader('Content-Disposition', 'attachment; filename="fixture.mp4"');
            return createReadStream(path, { start, end }).pipe(res);
          }
          res.setHeader('Content-Type', 'application/json');
          if (mode === 'error') {
            res.statusCode = 503;
            return res.end(JSON.stringify({ message: '隔离测试：服务暂时不可用' }));
          }
          if (req.method === 'POST') {
            if (url.endsWith('/retry')) recovered.add(mode);
            if (url.endsWith('/cancel')) cancelled.add(mode);
            if (url.endsWith('/render')) {
              let body = '';
              req.on('data', (chunk: Buffer) => (body += chunk.toString()));
              req.on('end', () => {
                try {
                  outputSettings.set(
                    mode!,
                    JSON.parse(body) as { resolution: string; frameRate: number },
                  );
                } catch {
                  outputSettings.set(mode!, { resolution: '720p', frameRate: 30 });
                }
                exported.add(mode!);
                res.end(JSON.stringify({ data: { accepted: true } }));
              });
              return;
            }
            return res.end(JSON.stringify({ data: { accepted: true } }));
          }
          const scenario = mode;
          const isCancelled = cancelled.has(scenario);
          if (exported.has(mode)) mode = 'running';
          if (recovered.has(mode)) mode = 'ready';
          if (mode === 'empty') return res.end(JSON.stringify({ data: [] }));
          const output = url.includes('/final-output');
          const items = Array.from({ length: 100 }, (_, i) => {
            const status =
              isCancelled && mode === 'running' && i >= 20
                ? 'CANCELLED'
                : mode === 'pending'
                  ? 'PENDING_RENDER'
                  : mode === 'running'
                    ? i < 20
                      ? 'COMPLETED'
                      : i < 24
                        ? 'RUNNING'
                        : 'QUEUED'
                    : mode === 'failed' && i === 99
                      ? 'FAILED'
                      : 'COMPLETED';
            const common = {
              id: `i${i}`,
              variantId: `v${i}`,
              name: `成片 ${String(i + 1).padStart(3, '0')} · ${demoNames[i % demoNames.length]}`,
              status,
              errorMessage:
                status === 'FAILED'
                  ? '测试失败：可恢复，不重做成功项'
                  : status === 'CANCELLED'
                    ? '测试已取消'
                    : null,
            };
            if (output)
              return {
                ...common,
                duration: demoDurations[i % demoDurations.length],
                progress: status === 'COMPLETED' ? 100 : status === 'RUNNING' ? 50 : 0,
                fileObjectId: status === 'COMPLETED' ? 'video' : null,
                assetId: null,
              };
            return {
              ...common,
              shardIndex: Math.floor(i / 4),
              sourceTimelineHash: 'fixture',
              sourceVisualTimeline: {
                id: `v${i}`,
                slots: [],
                bindings: {},
                bindingRevisions: {},
                offsets: {},
                timelineStarts: {},
                videoLanes: {},
              },
              stage: status === 'COMPLETED' ? 'READY' : status === 'RUNNING' ? 'VOICE' : 'SNAPSHOT',
              checkpoint: {},
              stale: mode === 'stale' && i === 99,
              startedAt: null,
              completedAt: null,
            };
          });
          const completed = items.filter((i) => i.status === 'COMPLETED').length;
          const run = {
            id: 'fixture-output',
            templateId: 'fixture-template',
            templateName: '演示商品模板',
            workflowRunId: 'fixture-run',
            resolution: outputSettings.get(scenario)?.resolution ?? '720p',
            frameRate: outputSettings.get(scenario)?.frameRate ?? 30,
            createdAt: new Date(0).toISOString(),
            startedAt: new Date(0).toISOString(),
            completedAt: null,
            status: isCancelled
              ? 'CANCELLED'
              : mode === 'pending'
                ? 'PENDING_RENDER'
                : mode === 'running'
                  ? 'RUNNING'
                  : mode === 'failed'
                    ? 'PARTIAL'
                    : 'COMPLETED',
            items,
            counts: {
              total: 100,
              completed,
              queued: isCancelled ? 0 : mode === 'pending' ? 100 : mode === 'running' ? 76 : 0,
              running: isCancelled ? 0 : mode === 'running' ? 4 : 0,
              failed: isCancelled ? 80 : mode === 'failed' ? 1 : 0,
              stale: mode === 'stale' ? 1 : 0,
              shards: 25,
            },
            execution: {
              progressPercent: 22,
              queued: 76,
              running: 4,
              completed: 20,
              elapsedSeconds: 400,
              throughputPerMinute: 3,
              estimatedRemainingSeconds: 1600,
              estimateBasis: 'OBSERVED',
              delayed: false,
              shards: [],
            },
          };
          return res.end(JSON.stringify({ data: [run] }));
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../../..', import.meta.url))] },
  },
});
