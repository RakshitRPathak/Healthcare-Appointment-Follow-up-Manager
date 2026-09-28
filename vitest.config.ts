import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,             // all files share one Postgres database
    testTimeout: 20_000,
    env: { DATABASE_URL: 'postgresql://ham:ham@localhost:5432/ham_test', BCRYPT_COST: '4' },
  },
});
