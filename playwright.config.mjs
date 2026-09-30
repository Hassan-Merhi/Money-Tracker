import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:'./e2e',
  fullyParallel:false,
  workers:1,
  retries:0,
  timeout:45_000,
  expect:{timeout:8_000},
  reporter:process.env.CI?[['line'],['html',{open:'never',outputFolder:'playwright-report'}]]:'line',
  use:{
    baseURL:'http://127.0.0.1:4173',
    trace:'retain-on-failure',
    screenshot:'only-on-failure',
    video:'retain-on-failure'
  },
  webServer:{
    command:'node scripts/e2e-server.mjs',
    url:'http://127.0.0.1:4173/api/health',
    reuseExistingServer:!process.env.CI,
    timeout:30_000
  }
});
