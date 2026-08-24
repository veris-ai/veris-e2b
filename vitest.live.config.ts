import { defineConfig } from 'vitest/config'

// Opt-in live suite: touches real E2B + Veris. Requires E2B_API_KEY,
// VERIS_API_KEY, VERIS_ENVIRONMENT_ID, and VERIS_E2E=proxy|gateway.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
})
