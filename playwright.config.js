import { defineConfig } from '@playwright/test';
import { bookContent } from './src/content.js';
export default defineConfig({
  testDir: './tests',
  outputDir: `stories/${bookContent.storyId}/qa/test-results`,
  testMatch: '**/*.spec.js',
  timeout: 45000,
  workers: 1,
  use: {
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  },
  webServer: { command: 'npm run dev -- --port 5173', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
