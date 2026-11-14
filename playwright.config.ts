import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, E2E_PROJECT_DIR } from './e2e/project';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localcloud:localcloud@127.0.0.1:5432/localcloud';

/**
 * Browser tests against the built app (`npm run build`), served by the standalone server for a
 * throwaway project. Terraform runs are mocked in the tests; everything else is the real API.
 * The server (and so these tests) needs Postgres: docker compose up -d postgres.
 */
export default defineConfig({
  testDir: 'e2e',
  // One server and one project folder: run in order
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `DATABASE_URL=${DATABASE_URL} node dist-server/cli.cjs ${E2E_PROJECT_DIR} --port ${E2E_PORT}`,
    url: `http://127.0.0.1:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
