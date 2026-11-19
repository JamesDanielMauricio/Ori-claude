# Shipping database changes

How a change to the database's structure reaches **dev** and **live**. Since
2026-11-17 there are two Supabase projects: dev (`owjgzyxuldmgvwxnhrom`,
made-up data) and live (`zvzqfjrxknxigddkwlir`, the real business).

## The routine

1. **A new numbered file.** Every structure change is a new file in
   `packages/db/migrations`, plus its entry in `meta/_journal.json`.
   - The entry's `when` is the time the file was written, in milliseconds
     (what `Date.now()` gives). Two pull requests then never pick the same one.
   - A file that has already run anywhere is never edited: a fix is another
     new file.
2. **Dev, by hand.** In a terminal, set `DATABASE_URL` to dev's session pooler
   address, then run `pnpm db:migrate` from the repository folder. It runs only
   the files dev doesn't have yet. Try the change on the dev site.
3. **Live, automatically.** Merge the pull request on GitHub. The
   `migrate-live` job (`.github/workflows/migrate-live.yml`) runs
   `packages/db/scripts/migrate-live.ts`, which:
   - checks live's migration log against the merged files;
   - runs the new ones on live, over an encrypted connection;
   - checks that live recorded each of them.

   Vercel serves the new website only after that job has passed.

Merging is going live, so merge when it's a good moment for live — not while
customers are ordering.

**Never paste a migration file into live's SQL Editor.** Pasting writes nothing
to Drizzle's log, so the job would run that file again. If it ever happens, tell
Claude before the next merge.

**Still by hand, live only:**
- fixes to real records: one-off SQL that is not a migration, which Claude
  labels "live only";
- deploying the `whatsapp-dispatch` edge function.

## One-time setup, in this order

1. **Fix live's migration log.** In the Supabase dashboard, open the live
   project → SQL Editor → New query, paste the whole of
   `packages/db/scripts/backfill-live-migration-log.sql`, and Run. Tell Claude,
   who checks it read-only.
2. **Give GitHub the live address.** On GitHub: the repository → Settings →
   Environments → New environment, named `live-database`.
   - Leave *Deployment branches and tags* as it is: no branch limit (James's
     choice, 2026-11-18; only collaborators can push branches).
   - Add no required reviewers: no Approve click.
   - Under *Environment secrets*, add `LIVE_DATABASE_URL`. Its value is live's
     session pooler address, the same as the `DATABASE_URL` line in
     `.env.prod.local`. Paste it exactly as it is there: inside an address, the
     password's `%` codes are correct.
3. **Merge the setup pull request.** This is the first run. With nothing new to
   run, the job should go green and print "Live already has every migration
   file: nothing new to run."
4. **Make Vercel wait for it.** In Vercel: the project → Settings → Build and
   Deployment → Deployment Checks → Add Checks → GitHub → *Select checks to
   add* → choose `migrate-live`. (Not *Send workflow updates to Vercel*: that
   one needs a change to the job.)
   - Vercel also needs *Auto-assign Custom Production Domains* to be on. That
     is its default: Settings → Environments → click *Production* → *Branch
     Tracking*.
   - If there is no *Deployment Checks* section on your plan, tell Claude:
     there is a fallback.
5. **Make merging wait for the checks.** On GitHub: the repository → Settings →
   Rules → Rulesets → "protect main and develop" → turn on *Require status
   checks to pass* → add `ci`. With no Approve click, these checks stop a broken
   file before it reaches live. They also stop a journal that would make
   Drizzle skip a file.
6. **Check once that Vercel really waits.** Vercel's documentation speaks of
   holding *custom* domains, and the live site is on `ori-claude-web.vercel.app`.
   On the next merge, open the new deployment in Vercel: its page should list
   `migrate-live` under its checks and say it was promoted only after the check
   passed. Then tell Claude, who confirms which version the live site is
   serving. If the new site went live without waiting for the check, tell
   Claude: the fallback makes GitHub start the deployment itself, after the
   database is done.

## When `migrate-live` is red

- **Nothing changed.** The checks refuse before anything runs, and Drizzle runs
  all new files in one transaction, so a failing file undoes the whole run.
  Vercel keeps serving the previous site.
- **Why:** GitHub emails you. Open the run (Actions → Migrate live) and the red
  step.
  - A refusal starts with `Refusing:` and says what to do.
  - A file that failed on live starts with `Failed:`. It shows only the error
    code, its message, and the table, column and constraint involved. The log
    is public, so the database's own detail lines are never printed, because
    they can quote customers' data.
- **Fix it in a new pull request**, never by hand on live. Merging it runs the
  job again. To retry unchanged (e.g. after fixing the secret), use *Re-run jobs*
  on the run's page.
- **Never use Vercel's "Force Promote"** on a held deployment: it would serve
  the new site against the old database.

## How a file could be skipped without a word

Drizzle tells migration files apart only by their `when`, and runs a file only
if its `when` is later than the last file live ran. So a file would be skipped
for good, without a word, if:

- its `when` is **earlier** than one live already ran (two pull requests,
  merged in the other order);
- its `when` is **the same** as another file's;
- live already ran **a different file at that `when`** — a merged migration
  whose pull request was then reverted (reverting does not undo a database
  change), or a file that was renumbered or edited after it ran.

The `ci` check stops the first two before a merge: a test reads the real journal.
`migrate-live` stops all three before running anything, and names the file.
The fix is always a new pull request that gives the file a new, current `when`,
or a new migration that puts live right.
