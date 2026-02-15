import { defineConfig, devices } from '@playwright/test';

// E2E tests use dedicated TEST_PORT (defaults to 3300) to avoid conflicts with dev server
const TEST_PORT = process.env.TEST_PORT || '3300';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 3,
  timeout: 60000,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: `http://localhost:${TEST_PORT}`,
    trace: 'on-first-retry',
    navigationTimeout: 30000,
  },
  projects: [
    // Auth setup -- runs first, saves storage state for authenticated tests
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },

    // Unauthenticated tests -- no dependencies, no stored auth
    {
      name: 'unauthenticated',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
      testMatch: /auth\.spec\.ts|landing\.spec\.ts|marketing-pages\.spec\.ts/,
    },

    // Mobile viewport tests -- unauthenticated, small screen
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 667 },
      },
      testMatch: /landing-mobile\.spec\.ts/,
    },

    // Authenticated tests -- depend on setup project
    {
      name: 'authenticated',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/user.json',
      },
      dependencies: ['setup'],
      testIgnore: /auth\.(spec|setup)\.ts|landing\.spec\.ts|landing-mobile\.spec\.ts|marketing-pages\.spec\.ts/,
    },
  ],
  webServer: {
    command: `PORT=${TEST_PORT} ALLOW_REGISTRATION=true npm run dev`,
    url: `http://localhost:${TEST_PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
