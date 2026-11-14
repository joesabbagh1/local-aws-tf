import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createApiMiddleware } from './server/api';

export default defineConfig({
  plugins: [
    react(),
    {
      // The local API (projects, Terraform runner, emulator control, data explorer) lives in server/api.ts.
      // Dev needs Postgres like production: `docker compose up -d postgres` then DATABASE_URL=... npm run dev
      name: 'local-cloud-emulator-api',
      configureServer(server) {
        if (!process.env.DATABASE_URL) {
          console.warn(
            '[localcloud] DATABASE_URL is not set — project routes will answer 503.\n' +
              '[localcloud]   docker compose up -d postgres\n' +
              '[localcloud]   DATABASE_URL=postgres://localcloud:localcloud@127.0.0.1:5434/localcloud npm run dev'
          );
        }
        server.middlewares.use(
          createApiMiddleware({ databaseUrl: process.env.DATABASE_URL, defaultProjectDir: process.cwd() })
        );
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
