import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('../..', import.meta.url));
  const environment = loadEnv(mode, envDir, '');
  const apiTarget =
    environment.VITE_API_PROXY_TARGET || `http://localhost:${environment.API_PORT || '3000'}`;

  return {
    envDir,
    plugins: [vue()],
    optimizeDeps: {
      include: ['@ai-marketing/contracts'],
      needsInterop: ['@ai-marketing/contracts'],
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
  };
});
