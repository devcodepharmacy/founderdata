import { defineConfig } from 'vitest/config';

// The Worker tests seed hundreds of sessions; 5 s is too tight on a busy machine or a CI runner.
export default defineConfig({ test: { include: ['test/**/*.test.ts', 'pro/test/**/*.test.ts'], setupFiles: ['test/setup-edition.ts'], testTimeout: 20_000, hookTimeout: 60_000 } });
