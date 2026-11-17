# Live database updates itself on merge — design

Date: 2026-11-17. Approved by James in conversation ("yes", 2026-11-17).

## Intent

James runs new migration files by hand on the **dev** project only. When a pull
request is merged into **main on GitHub**, the **live** project gets the same new
files automatically, and only then does the new website go live. No more pasting
migration files into live's SQL Editor. He chose **fully automatic** — no Approve
click — after I recommended the click.

## Goals

- Merge → live runs every migration file it does not have yet → the new website
  is served only after that succeeded.
- A failure changes nothing on live (database and website stay as they were) and
  GitHub emails him.
- Website-only merges keep working as today (they wait about a minute for the job).

## Non-goals

- Automating dev (stays by hand: `pnpm db:migrate` with `DATABASE_URL` = dev).
- Switching to Supabase CLI migrations (Drizzle stays).
- Deploying the whatsapp-dispatch edge function (stays by hand).
- Copying anything from dev's database: the same *files* run, dev's data never moves.

## Anti-goals (a failure even if it "works")

- Re-running 0034+ on live (live's Drizzle log stops at 0033: 34 rows, last
  `created_at` 1783870018810).
- The new website serving against an old database.
- A broken migration file reaching live.
- The live database address readable by a pull request on the public repo.

## Approaches

| | Approach | Verdict |
|---|---|---|
| A | GitHub Actions job on push to main runs `pnpm db:migrate` on live; **Vercel Deployment Checks** hold the new production deployment until that job passes | **Chosen.** No deploy hook, no Vercel token, Vercel's git integration unchanged |
| A′ | Same job, then a Vercel deploy hook; `git.deploymentEnabled.main = false` | Fallback only if Deployment Checks are not on his plan. Vercel's docs don't say whether hooks still fire with `deploymentEnabled` off (they don't with the old `github.enabled = false`), so it would need a test |
| B | Supabase's GitHub integration | No: paid branching + the CLI switch he dropped |
| C | Migrate inside the Vercel build | No: every branch preview would run unfinished files on dev; build retries would re-run it |

Mechanism change from what he approved: I first described a deploy hook (A′).
Deployment Checks do the same job with fewer moving parts. This is my call.

## Design

1. **Workflow `.github/workflows/migrate-live.yml`**:
   - Trigger: `push` to `main`, every push with no path filter. Vercel waits for
     the check on every production deployment, so the check must always appear.
   - Concurrency: group `migrate-live`, never cancel a run in progress.
   - Job id and name: `migrate-live`.
   - Environment `live-database`: deployment branches = `main` only, no
     reviewers. It holds the secret `LIVE_DATABASE_URL`: the session pooler URL,
     password URL-encoded.
   - Permissions: `contents: read`.
   - Steps: checkout, pnpm 10.15.0, node from `.nvmrc`, install the db package
     and its dependencies, the guard, `pnpm db:migrate`.
2. **Guard `packages/db/scripts/check-live-migration-log.ts`**. Its decision is a
   pure function in `scripts/lib/live-migration-guard.ts`, unit-tested. It refuses
   to continue (non-zero exit) when:
   - the URL is not the live project (`zvzqfjrxknxigddkwlir`);
   - live's log does not reach 0106 (`created_at` 1793307600000), which means the
     one-time backfill was not run;
   - a journal file older than the log's last entry is missing from the log.
     Drizzle compares only the last `created_at`, so such a file (two branches
     merged out of order) would be skipped forever without a word.

   Otherwise it prints the files that will run.
3. **One-time backfill `packages/db/scripts/backfill-live-migration-log.sql`**,
   live only:
   - Inserts the 73 log rows for 0034–0106 (hash and `created_at` copied from
     dev's log, which Drizzle wrote from the same files).
   - Safe to run again.
   - Refuses unless the log is in its 34-row state or already backfilled, and
     unless 0106 is really applied (the WhatsApp schedule reads Vault `project_url`).
4. **Vercel**: Project Settings → Build and Deployment → Deployment Checks → Add
   Checks → GitHub → `migrate-live`. The check must have run once first.
5. **GitHub ruleset** "protect main and develop": require status check `ci`
   before merge. With no click, the PR checks are the gate.
6. **Doc `docs/shipping-database-changes.md`**: the routine.
   - Dev by hand.
   - Live automatic.
   - Never paste a migration file on live.
   - Real-data fixes are still by hand, live only.

## Behaviour on failure

Drizzle runs all pending files in one transaction, so a failing file rolls back
everything. The check goes red, Vercel keeps serving the previous deployment, and
GitHub emails the person who merged. (Vercel's "Force Promote" would bypass the
check; never use it for this.)

## Rollout order

1. James runs the backfill on live; I verify it read-only.
2. James creates environment `live-database` + secret `LIVE_DATABASE_URL`.
3. He merges the setup PR. This is the first run: nothing pending, so the job
   goes green. The branch is cut from GitHub main 6fa8a76, so it does not carry
   0107.
4. He adds the Deployment Check and the required `ci` check.
5. The first real run is the WhatsApp routing PR (0107), after 0107 has gone on
   dev by hand.

## Left to the builder

File layout inside `scripts/`, the test cases' shape, the doc's wording.

## Revised after the final review (2026-11-17)

The guard script and `pnpm db:migrate` became **one script,
`packages/db/scripts/migrate-live.ts`** (`pnpm --filter @ori/db db:migrate-live`):

- **One connection, encrypted:** `ssl: "require"`. postgres.js does not encrypt
  unless told to.
- **Drizzle's own migrator**, the same function `drizzle-kit migrate` calls, so
  the run is still one transaction.
- **Errors print only code, message, table, column and constraint.** The
  `detail`, `where` and `hint` fields can quote live rows into the public log.
  Notices are dropped.
- **It reads the log again afterwards:** green means every file was recorded.
- **The entry point always runs its checks.** It no longer asks "was I started
  directly?", a check that could answer wrong and pass silently.

The guard also refuses on:

- **A journal out of order:** `when`s that are not strictly increasing, an idx
  gap, or a repeated tag. The same check runs on the real journal in CI.
- **A row live logged above the 0106 floor that this checkout does not have**,
  at that `when` with that hash. That means a reverted pull request, or a
  renumbered or edited file.

New files take the current time as their `when`. The doc now asks for a
one-time check that Deployment Checks hold `ori-claude-web.vercel.app`; Vercel's
docs speak of custom domains.

## Open

- Whether Deployment Checks are available on his Vercel plan. He looks at the
  settings page; if they're missing → A′.
