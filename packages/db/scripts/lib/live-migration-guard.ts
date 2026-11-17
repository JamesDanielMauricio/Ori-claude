// Decides whether the migrate-live job (.github/workflows/migrate-live.yml) may
// run `drizzle-kit migrate` against the LIVE Supabase project, and which
// migration files that run will apply. Pure: no database, no files — the
// script check-live-migration-log.ts feeds it the journal and live's log.
//
// How Drizzle picks what to run (drizzle-orm's migrator): it reads only the
// LAST row of drizzle.__drizzle_migrations, by created_at, and runs every
// journal entry whose `when` is later. Two consequences this guards against:
// - a log that is behind the database (live's stopped at 0033 because 0034+
//   were pasted by hand) makes it re-run files on real data;
// - a file whose `when` is earlier than the last logged one is skipped
//   forever, without a word (two branches merged out of order).

export const LIVE_PROJECT_REF = "zvzqfjrxknxigddkwlir";

// 0106's `when`. Every file up to and including 0106 was applied to live by
// hand, so live's log must record them (scripts/backfill-live-migration-log.sql)
// before Drizzle may decide anything there.
export const BACKFILL_FLOOR_WHEN = 1793307600000;

export type JournalEntry = { idx: number; when: number; tag: string };

export type GuardResult = { ok: true; pending: JournalEntry[] } | { ok: false; reason: string };

// SECURITY: only an address that names the live project in its user name
// (session pooler: postgres.<ref>) or its host (direct: db.<ref>.supabase.co)
// counts as live. It ALLOWS the job to run against live and nowhere else.
// It PROTECTS AGAINST migrating the wrong database because the secret holds
// dev's (or any other) address — including one that merely mentions the live
// ref somewhere else, such as inside the password.
export function isLiveDatabaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.username === `postgres.${LIVE_PROJECT_REF}` || parsed.hostname === `db.${LIVE_PROJECT_REF}.supabase.co`;
}

// The address part of the decision, on its own so the script can refuse
// before it connects anywhere. Null = it is live's address.
export function liveUrlProblem(databaseUrl: string | undefined): string | null {
  if (!databaseUrl) {
    return "DATABASE_URL is empty: the LIVE_DATABASE_URL secret is missing from the live-database environment (GitHub → Settings → Environments → live-database).";
  }
  if (!isLiveDatabaseUrl(databaseUrl)) {
    return `The LIVE_DATABASE_URL secret is not the live project (${LIVE_PROJECT_REF}). Nothing was run. Put live's session pooler address in the secret.`;
  }
  return null;
}

export function checkLiveMigrationLog(input: {
  databaseUrl: string | undefined;
  journal: JournalEntry[];
  loggedWhens: number[];
}): GuardResult {
  const urlProblem = liveUrlProblem(input.databaseUrl);
  if (urlProblem) return { ok: false, reason: urlProblem };

  const lastLogged = input.loggedWhens.length > 0 ? Math.max(...input.loggedWhens) : Number.NEGATIVE_INFINITY;
  if (lastLogged < BACKFILL_FLOOR_WHEN) {
    return {
      ok: false,
      reason:
        "Live's migration log does not reach 0106 yet. Run packages/db/scripts/backfill-live-migration-log.sql on live once (SQL Editor), then re-run this job. Without it, every file from 0034 on would run again on real data.",
    };
  }

  const logged = new Set(input.loggedWhens);
  const skipped = input.journal.filter((entry) => entry.when <= lastLogged && !logged.has(entry.when));
  if (skipped.length > 0) {
    return {
      ok: false,
      reason: `These files are older than the last one live ran, but live never ran them, so Drizzle would skip them for good: ${skipped
        .map((entry) => entry.tag)
        .join(", ")}. Nothing was run. Give each one a "when" in meta/_journal.json later than ${lastLogged} (renumbering it after the newest file is clearest), then merge again.`,
    };
  }

  const pending = input.journal.filter((entry) => entry.when > lastLogged).sort((a, b) => a.when - b.when);
  return { ok: true, pending };
}
