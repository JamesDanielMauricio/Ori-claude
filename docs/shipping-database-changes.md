# Shipping database changes

How a change to the database's structure reaches **dev** and **live**. Since
2026-11-17 there are two Supabase projects: dev (`owjgzyxuldmgvwxnhrom`,
made-up data) and live (`zvzqfjrxknxigddkwlir`, the real business).

## The routine

1. **A new numbered file.** Every structure change is a new file in
   `packages/db/migrations`, plus its entry in `meta/_journal.json`. A file that
   has already run anywhere is never edited: a fix is another new file.
2. **Dev, by hand.** In a terminal, set `DATABASE_URL` to dev's session pooler
   address, then run `pnpm db:migrate` from the repository folder. It runs only
   the files dev doesn't have yet. Try the change on the dev site.
3. **Live, automatically.** Merge the pull request on GitHub. The `migrate-live`
   job (`.github/workflows/migrate-live.yml`) runs the same new files on live,
   and Vercel serves the new website only after that job has passed.

Merging is going live, so merge when it's a good moment for live — not while
customers are ordering.

**Never paste a migration file into live's SQL Editor.** Pasting writes nothing
to Drizzle's log, so the job would run that file again. If it ever happens, tell
Claude before the next merge.

**Still by hand, live only:** fixes to real records (one-off SQL that is not a
migration — Claude labels these "live only") and deploying the `whatsapp-dispatch`
edge function.

## One-time setup, in this order

1. **Fix live's migration log.** In the Supabase dashboard, open the live
   project → SQL Editor → New query, paste the whole of
   `packages/db/scripts/backfill-live-migration-log.sql`, and Run. Tell Claude,
   who checks it read-only.
2. **Give GitHub the live address.** On GitHub: the repository → Settings →
   Environments → New environment, named `live-database`.
   - Under *Deployment branches and tags*, choose *Selected branches and tags*
     and add `main`.
   - Add no required reviewers: no Approve click.
   - Under *Environment secrets*, add `LIVE_DATABASE_URL`. Its value is live's
     session pooler address, the same as the `DATABASE_URL` line in
     `.env.prod.local`. Paste it exactly as it is there: inside an address, the
     password's `%` codes are correct.
3. **Merge the setup pull request.** This is the first run. With nothing new to
   run, the job should go green and print
   "Live already has every migration file: nothing new to run."
4. **Make Vercel wait for it.** In Vercel: the project → Settings → Build and
   Deployment → Deployment Checks → Add Checks → GitHub → choose
   `migrate-live`. If there is no *Deployment Checks* section on your plan,
   tell Claude: there is a fallback.
5. **Make merging wait for the checks.** On GitHub: the repository → Settings →
   Rules → Rulesets → "protect main and develop" → turn on *Require status
   checks to pass* → add `ci`. With no Approve click, these checks are what
   stop a broken file before it reaches live.

## When `migrate-live` is red

- **Nothing changed.** The guard refuses before anything runs, and Drizzle runs
  all new files in one transaction, so a failing file undoes the whole run.
  Vercel keeps serving the previous site.
- **Why:** GitHub emails you. Open the run (Actions → Migrate live) and the red
  step. A refusal from the guard starts with `Refusing:` and says what to do.
- **Fix it in a new pull request**, never by hand on live. Merging it runs the
  job again. To retry unchanged (e.g. after fixing the secret), use *Re-run jobs*
  on the run's page.
- **Never use Vercel's "Force Promote"** on a held deployment: it would serve
  the new site against the old database.

## The out-of-order trap

Drizzle runs only the files whose `when` (in `meta/_journal.json`) is later than
the last file live ran. If two pull requests each add a file, and the one with
the *later* file is merged first, the other file would be skipped for good —
without a word. The guard stops the run and names the file. The fix is a pull
request that gives that file a later `when`; renumbering it after the newest
file is clearest.
