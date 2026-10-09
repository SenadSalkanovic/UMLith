import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:4317' } },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20000, hookTimeout: 20000, pool: 'forks', maxWorkers: 2 },
});
