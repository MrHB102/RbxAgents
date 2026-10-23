import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './tests/e2e', workers: 1, timeout: 120_000, reporter: 'list', use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' } })
