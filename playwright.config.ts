import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3100';
const frontendPort = new URL(baseURL).port || '3100';
const nextBin = process.platform === 'win32'
  ? 'frontend\\node_modules\\next\\dist\\bin\\next'
  : 'frontend/node_modules/next/dist/bin/next';
const frontendCommand = process.env.CI
  ? `node ${nextBin} start frontend -p ${frontendPort}`
  : `node ${nextBin} dev frontend -p ${frontendPort}`;
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: './tests/playwright',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'playwright-report/results.json' }],
  ],
  use: {
    baseURL,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    launchOptions: chromiumExecutablePath
      ? {
          executablePath: chromiumExecutablePath,
        }
      : undefined,
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  webServer: {
    command: frontendCommand,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGINT', timeout: 1_000 },
    env: {
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3999',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: 'test-results/playwright',
});
