import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['list'], ['json', { outputFile: '.local/verification/browser-results.json' }]],
  outputDir: '.local/browser-results',
  globalTeardown: './tests/browser/teardown.ts',
  use: {
    baseURL: 'http://127.0.0.1:3107',
    actionTimeout: 15000,
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --import tsx scripts/browser-server.ts',
    url: 'http://127.0.0.1:3107/health/ready',
    timeout: 120000,
    reuseExistingServer: false,
  },
});
