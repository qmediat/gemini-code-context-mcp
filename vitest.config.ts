import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
    // 30 s gives the timer-based tests in `ask-agentic` / `abort-timeout` enough
    // headroom on slower GitHub Actions runners. Locally these tests pass in
    // ~1.5–3 s each, but CI runners can be 2–3× slower, and the previous 10 s
    // ceiling produced flaky `release.yml` failures (v1.7.0 release run lost
    // provenance attestation as a result).
    testTimeout: 30_000,
  },
});
