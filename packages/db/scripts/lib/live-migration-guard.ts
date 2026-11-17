// Decides whether the migrate-live job (.github/workflows/migrate-live.yml) may
// run Drizzle's migrator against the LIVE Supabase project, and which
// migration files that run will apply. Pure: no database, no files —
// migrate-live.ts (next to this file) feeds it the journal, this checkout's
// file hashes and live's log.
//
// How Drizzle picks what to run (drizzle-orm's migrator): it reads only the
// LAST row of drizzle.__drizzle_migrations, by created_at, and runs every
// journal entry whose `when` is later. It tells files apart by `when` alone.
// The consequences this guards against:
// - a log that is behind the database (live's stopped at 0033 because 0034+
//   were pasted by hand) makes it re-run files on real data;
// - a file whose `when` is earlier than the last logged one is skipped
//   forever, without a word (two branches merged out of order);
// - two files with the same `when`: only one ever runs;
// - live having run a file this checkout does not have at that `when` (a
//   reverted pull request, or a renumbered or edited file): a new file
//   that reuses the `when` would be taken as already run.

export const LIVE_PROJECT_REF = "zvzqfjrxknxigddkwlir";

// 0106's `when`. Every file up to and including 0106 was applied to live by
// hand, so live's log must record them (scripts/backfill-live-migration-log.sql)
// before Drizzle may decide anything there.
export const BACKFILL_FLOOR_WHEN = 1793307600000;

export type JournalEntry = { idx: number; when: number; tag: string };

// One row of live's drizzle.__drizzle_migrations: the file's sha256 as Drizzle
// computed it, and its journal `when` (the created_at column).
export type LoggedRow = { hash: string; when: number };

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

// What is wrong with the journal itself, one line per problem: entries must be
// numbered one after another, with distinct tags, and each `when` later than
// the one before. Also run on the real journal by journal-integrity.test.ts,
// so a pull request that breaks this fails its checks before it can merge.
export function journalProblems(journal: JournalEntry[]): string[] {
  const problems: string[] = [];
  const seenTags = new Set<string>();
  journal.forEach((entry, i) => {
    if (seenTags.has(entry.tag)) problems.push(`${entry.tag} appears more than once.`);
    seenTags.add(entry.tag);
    const before = journal[i - 1];
    if (before === undefined) return;
    if (entry.idx !== before.idx + 1) problems.push(`${entry.tag} has idx ${entry.idx}; the entry before it has idx ${before.idx}.`);
    if (!(entry.when > before.when)) {
      problems.push(`${entry.tag}'s "when" (${entry.when}) is not later than ${before.tag}'s (${before.when}).`);
    }
  });
  return problems;
}

export function checkLiveMigrationLog(input: {
  databaseUrl: string | undefined;
  journal: JournalEntry[];
  // tag → sha256 of that migration file, computed the way Drizzle does.
  fileHashes: Record<string, string>;
  logged: LoggedRow[];
}): GuardResult {
  const urlProblem = liveUrlProblem(input.databaseUrl);
  if (urlProblem) return { ok: false, reason: urlProblem };

  const broken = journalProblems(input.journal);
  if (broken.length > 0) {
    return {
      ok: false,
      reason: `The migration journal (meta/_journal.json) is out of order, so Drizzle would skip a file without a word: ${broken.join(" ")} Nothing was run. Fix it in a new pull request: each new file's "when" is the time it was written.`,
    };
  }

  const loggedWhens = input.logged.map((row) => row.when);
  const lastLogged = loggedWhens.length > 0 ? Math.max(...loggedWhens) : Number.NEGATIVE_INFINITY;
  if (lastLogged < BACKFILL_FLOOR_WHEN) {
    return {
      ok: false,
      reason:
        "Live's migration log does not reach 0106 yet. Run packages/db/scripts/backfill-live-migration-log.sql on live once (SQL Editor), then re-run this job. Without it, every file from 0034 on would run again on real data.",
    };
  }

  // Every row this job wrote (all of them above the floor) must be a file of
  // this checkout, byte for byte: same `when`, same hash. Rows at or below the
  // floor came from the one-time backfill and carry dev's hashes, which differ
  // from this checkout's (line endings), so only their `when` is compared.
  const byWhen = new Map(input.journal.map((entry) => [entry.when, entry]));
  const foreign = input.logged
    .filter((row) => row.when > BACKFILL_FLOOR_WHEN)
    .flatMap((row) => {
      const entry = byWhen.get(row.when);
      if (entry === undefined) return [`live ran a file at "when" ${row.when}, which this checkout's journal does not have`];
      if (input.fileHashes[entry.tag] !== row.hash) return [`live ran a different file at "when" ${row.when} than this checkout's ${entry.tag}`];
      return [];
    });
  if (foreign.length > 0) {
    return {
      ok: false,
      reason: `${foreign.join("; ")}. Nothing was run. This happens after a migration's pull request is reverted (reverting does not undo a database change), or when a file that already ran on live is renumbered or edited. Ask Claude for a new migration file that puts it right.`,
    };
  }

  const logged = new Set(loggedWhens);
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
