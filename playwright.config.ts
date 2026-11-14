import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT, E2E_PROJECT_DIR } from './e2e/project';

/**
 * Browser tests against the built app (`npm run build`), served by the standalone server for a
 * throwaway project. Terraform runs are mocked in the tests; everything else is the real API.
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
    command: `node dist-server/cli.cjs ${E2E_PROJECT_DIR} --port ${E2E_PORT}`,
    url: `http://127.0.0.1:${E2E_PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
