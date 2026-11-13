import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createApiMiddleware } from './server/api';

export default defineConfig({
  plugins: [
    react(),
    {
      // The local API (emulator control, Terraform runner, project file, data explorer) lives in server/api.ts
      name: 'local-cloud-emulator-api',
      configureServer(server) {
        server.middlewares.use(createApiMiddleware());
      },
    },
  ],
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
