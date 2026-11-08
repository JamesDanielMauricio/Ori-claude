import { defineConfig } from "vitest/config";

// Relative on purpose — see packages/domain/vitest.config.ts.
import { assertDisposableTestTargets } from "../../packages/shared/src/test-targets";

const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SUPABASE_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";

// SECURITY: ALLOWS these router tests to run only against a Supabase stack on
// this machine (the throwaway one CI starts). PROTECTS AGAINST running them
// against the hosted project the root .env points at — they sign in and create
// real Auth users. Checked while the config loads, before any test connects
// (release workbook task 01, ORI-022; same rule as packages/domain).
assertDisposableTestTargets({ databaseUrl: DATABASE_URL, supabaseUrl: SUPABASE_URL });

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    passWithNoTests: true,
    // Router tests exercise the real Supabase-backed auth domain layer —
    // see packages/domain/vitest.config.ts for why this is safe under full
    // parallelism (unique fixtures + explicit teardown, no shared-state
    // truncation).
    env: {
      DATABASE_URL,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_SERVICE_ROLE_KEY,
    },
  },
});
