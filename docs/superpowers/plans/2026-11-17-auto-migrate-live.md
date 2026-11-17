# Live Database Updates Itself on Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A merge into GitHub main runs every new migration file on the live Supabase project, and Vercel serves the new site only after that succeeded.

**Architecture:**
- A GitHub Actions job `migrate-live` runs on every push to main. It runs a guard script, then `pnpm db:migrate` against live.
- Vercel Deployment Checks hold each production deployment until `migrate-live` passes.
- A one-time SQL backfill makes live's Drizzle log match what was applied by hand.

**Tech Stack:** GitHub Actions, Drizzle Kit 0.30 (`postgres` driver), tsx, vitest 2, PGlite (test only, outside the repo).

**Spec:** `docs/superpowers/specs/2026-11-17-auto-migrate-live-design.md`

## Global Constraints

**Fixed values:**
- Live project ref `zvzqfjrxknxigddkwlir`; dev project ref `owjgzyxuldmgvwxnhrom`.
- 0033 `when` = `1783870018810` (live's log ends here: 34 rows). 0106 `when` = `1793307600000`.
- Actions versions as in `ci.yml`: `actions/checkout@v4`, `pnpm/action-setup@v4` with `version: 10.15.0`, `actions/setup-node@v4` with `node-version-file: ".nvmrc"`.
- Names: environment `live-database`, secret `LIVE_DATABASE_URL`, job id and name `migrate-live`.

**Never, from this machine:**
- Never connect to live or dev from this machine.
- Never run `drizzle-kit migrate`.
- Never source any `.env` file.
- Read-only MCP queries are allowed.

**Comments and secrets:**
- Every security rule gets a comment above it saying what it allows and what it protects against (James's CLAUDE.md).
- No secret values in any file.

## Review Focus

1. **A migration with an older `when` than live's last logged one** (two branches merged out of order). Drizzle silently never runs it. The guard must refuse and name the file.
2. **`LIVE_DATABASE_URL` missing or empty** (e.g. the setup merged before the secret exists). `drizzle.config.ts` falls back to localhost, so the guard must refuse first with a plain message.
3. **The live ref appearing somewhere other than the user name or host** (e.g. inside a password). Only the parsed username `postgres.<ref>` or host `db.<ref>.supabase.co` may count.
4. **The backfill run twice, or on dev by mistake.** Either way it is a no-op. It refuses on any log state it does not recognise, and when 0106's schedule is missing.
5. **Two merges in quick succession.** The runs are serialised; the second sees the first's log rows.

---

### Task 1: The guard's decision

**Files:**
- Create: `packages/db/scripts/lib/live-migration-guard.ts`
- Test: `packages/db/scripts/lib/live-migration-guard.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const LIVE_PROJECT_REF = "zvzqfjrxknxigddkwlir";
  export const BACKFILL_FLOOR_WHEN = 1793307600000; // 0106
  export type JournalEntry = { idx: number; when: number; tag: string };
  export type GuardResult =
    | { ok: true; pending: JournalEntry[] }
    | { ok: false; reason: string };
  export function isLiveDatabaseUrl(url: string): boolean;
  export function checkLiveMigrationLog(input: {
    databaseUrl: string | undefined;
    journal: JournalEntry[];
    loggedWhens: number[];
  }): GuardResult;
  ```

- [ ] **Step 1: Write the failing tests.** One `it` per case, using journal fixtures built from real tags/whens (0033 = 1783870018810, 0106 = 1793307600000, 0107 = 1793394000000):
  - `isLiveDatabaseUrl`:
    - true for `postgresql://postgres.zvzqfjrxknxigddkwlir:pw@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`;
    - true for `postgresql://postgres:pw@db.zvzqfjrxknxigddkwlir.supabase.co:5432/postgres`;
    - false for the same pooler URL with `owjgzyxuldmgvwxnhrom`;
    - false for `postgresql://postgres.owjgzyxuldmgvwxnhrom:zvzqfjrxknxigddkwlir@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres` (ref only in the password);
    - false for `not a url`.
  - `checkLiveMigrationLog`:
    - undefined or `""` URL → `ok: false`, reason contains `LIVE_DATABASE_URL`;
    - dev URL → `ok: false`, reason contains `not the live project`;
    - log of 34 whens ending at 1783870018810 → `ok: false`, reason contains `backfill`;
    - empty log → `ok: false`, reason contains `backfill`;
    - journal 0104/0105/0106/0107 with log missing 0105 but containing 0106 → `ok: false`, reason contains `0105_` tag;
    - log = every journal when → `ok: true, pending: []`;
    - log ends at 0106, journal has 0107 → `ok: true, pending: [0107 entry]`.
- [ ] **Step 2: Run** `pnpm --filter @ori/db exec vitest run scripts/lib/live-migration-guard.test.ts`.
  Expected: FAIL (module not found).
- [ ] **Step 3: Implement.**
  - `isLiveDatabaseUrl` parses with `new URL` inside try/catch and accepts only `username === "postgres." + ref` or `hostname === "db." + ref + ".supabase.co"`.
  - `checkLiveMigrationLog` checks in this order: URL present, URL is live, log max ≥ floor, no journal entry with `when ≤ max(logged)` missing from the logged set, then pending = entries with `when > max`.
  - Reasons are plain English, naming what to do.
  - A SECURITY comment explains the URL rule.
- [ ] **Step 4: Run the same command.** Expected: PASS, 12 tests.
- [ ] **Step 5: Commit** `feat(db): decide whether live may be migrated (guard logic)`.

### Task 2: The guard script

**Files:**
- Create: `packages/db/scripts/check-live-migration-log.ts`
- Test: `packages/db/scripts/check-live-migration-log.test.ts`
- Modify: `packages/db/package.json` (add `"db:check-live": "tsx scripts/check-live-migration-log.ts"`)

**Interfaces:**
- Consumes: Task 1's `checkLiveMigrationLog`, `JournalEntry`.
- Produces:
  ```ts
  export async function runGuard(deps: {
    databaseUrl: string | undefined;
    journal: JournalEntry[];
    readLoggedWhens: (url: string) => Promise<number[]>;
    log: (line: string) => void;
  }): Promise<number>; // exit code
  ```
  Plus a main block that does three things: reads `migrations/meta/_journal.json`, reads the logged whens with `postgres` (`select created_at from drizzle.__drizzle_migrations`, max 1 connection, then `end()`), and sets `process.exitCode`.

- [ ] **Step 1: Write the failing tests** with a fake `readLoggedWhens`:
  - a refused URL returns 1, never calls the reader, and logs the reason;
  - a reader that throws returns 1 and logs `could not read live's migration log`;
  - pending `[0107]` returns 0 and logs a line with `0107_whatsapp-routing-like-bubble`;
  - nothing pending returns 0 and logs `nothing new`.
- [ ] **Step 2: Run** `pnpm --filter @ori/db exec vitest run scripts/check-live-migration-log.test.ts`.
  Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** Main runs only when the file is executed directly, compared via `import.meta.url` and `pathToFileURL(process.argv[1])`.
- [ ] **Step 4: Run** the step 2 command. Expected: PASS.
  - Then check the refusal end to end with no network:
    - `pnpm --filter @ori/db db:check-live`, with `DATABASE_URL` unset → exit 1, prints the `LIVE_DATABASE_URL` reason.
  - Then confirm the query text on dev with the read-only MCP:
    - `select created_at from drizzle.__drizzle_migrations` → 107 rows.
- [ ] **Step 5: Commit** `feat(db): guard script run before migrating live`.

### Task 3: One-time backfill of live's log

**Files:**
- Create: `packages/db/scripts/backfill-live-migration-log.sql`

**Interfaces:**
- Consumes: dev's log rows for 0034–0106, read with the read-only MCP:
  `select hash, created_at from drizzle.__drizzle_migrations where created_at > 1783870018810 order by created_at`. Expect 73 rows, matching the journal's whens for idx 34–106 exactly.
- Produces: a file James runs once on live in the SQL Editor.

- [ ] **Step 1: Write the PGlite test script** in the session scratchpad, not the repo. It builds `drizzle.__drizzle_migrations (id serial, hash text, created_at bigint)` and a stub `cron.job(jobid int, command text)`, then runs four scenarios:
  - (a) 34 rows (whens 0000–0033) + a schedule row containing `project_url` → after the run, 107 rows and max = 1793307600000;
  - (b) run (a) again → still 107 rows;
  - (c) 34 rows, schedule without `project_url` → raises `0106`;
  - (d) 50 rows → raises `unexpected`.
- [ ] **Step 2: Run it.** Expected: FAIL (file missing).
- [ ] **Step 3: Write the SQL**:
  - a header (LIVE ONLY, not a migration, why, safe to run again);
  - `begin;`;
  - a `do` guard: the log is exactly the 34-row state, or already holds all 107 whens; and a `cron.job` command contains `project_url`;
  - one `insert … select … from (values …) where not exists (same created_at)`;
  - a check that the max is now 1793307600000;
  - `commit;`.
- [ ] **Step 4: Run it.** Expected: all 4 scenarios PASS.
- [ ] **Step 5: Commit** `chore(db): one-time backfill of live's migration log (0034–0106)`.

### Task 4: The workflow

**Files:**
- Create: `.github/workflows/migrate-live.yml`

**Interfaces:**
- Consumes: `pnpm --filter @ori/db db:check-live` (Task 2), `pnpm db:migrate`.

- [ ] **Step 1: Write a check script** in the scratchpad. It parses the YAML with the `yaml` package (scratchpad install) and asserts:
  - `on.push.branches` = `[main]` and no `pull_request` trigger;
  - `concurrency.group` = `migrate-live` with `cancel-in-progress` false;
  - `jobs.migrate-live.name` = `migrate-live` and environment `live-database`;
  - `permissions.contents` = `read`;
  - `DATABASE_URL` comes from `secrets.LIVE_DATABASE_URL` only on the two db steps;
  - step order checkout → pnpm → node → install → guard → migrate.
- [ ] **Step 2: Run it.** Expected: FAIL (file missing).
- [ ] **Step 3: Write the workflow.**
  - Install: `pnpm install --frozen-lockfile --filter @ori/db...`.
  - Each security rule gets a comment: why main-only, why the environment, why no `pull_request`, why read-only permissions, and why the secret is only on the two db steps.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit** `ci: migrate live on every push to main, before Vercel serves it`.

### Task 5: The routine, written down

**Files:**
- Create: `docs/shipping-database-changes.md`

- [ ] **Step 1: Write it** for James, in plain words:
  - dev by hand (`pnpm db:migrate` with `DATABASE_URL` = dev);
  - live automatic on merge;
  - never paste a migration file into live's SQL Editor; real-data fixes are still by hand, live only;
  - the one-time setup clicks (environment + secret, Deployment Check, required `ci` check) with their exact dashboard paths;
  - what a red `migrate-live` means and what to do;
  - the out-of-order trap.
- [ ] **Step 2: Verify:**
  - every name in it (`live-database`, `LIVE_DATABASE_URL`, `migrate-live`, `ci`) matches the workflow and `ci.yml`;
  - `pnpm lint` and `pnpm typecheck` pass.
- [ ] **Step 3: Commit** `docs: how database changes reach dev and live`.
