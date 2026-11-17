// Run by the migrate-live job (.github/workflows/migrate-live.yml) right before
// `pnpm db:migrate`, with the same DATABASE_URL, so it checks exactly the
// database Drizzle is about to change:
//
//   pnpm --filter @ori/db db:check-live
//
// Exit 0: safe to migrate live — it prints the files the run will apply.
// Exit 1: refused, with the reason — nothing was run. The decision itself is
// scripts/lib/live-migration-guard.ts; this file only feeds it. It only reads:
// one SELECT on live's migration log.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { checkLiveMigrationLog, liveUrlProblem, type JournalEntry } from "./lib/live-migration-guard";

export async function runGuard(deps: {
  databaseUrl: string | undefined;
  journal: JournalEntry[];
  readLoggedWhens: (url: string) => Promise<number[]>;
  log: (line: string) => void;
}): Promise<number> {
  const { databaseUrl } = deps;

  // SECURITY: the address is checked BEFORE any connection. It ALLOWS a
  // connection only to live's own address. It PROTECTS AGAINST sending the
  // database password to some other host because the secret was filled in
  // wrong — a refused address is never connected to.
  const urlProblem = liveUrlProblem(databaseUrl);
  if (urlProblem !== null || databaseUrl === undefined) {
    deps.log(`Refusing: ${urlProblem ?? "no database address."}`);
    return 1;
  }

  let loggedWhens: number[];
  try {
    loggedWhens = await deps.readLoggedWhens(databaseUrl);
  } catch (error) {
    deps.log(
      `Refusing: could not read live's migration log (${error instanceof Error ? error.message : String(error)}). Nothing was run.`,
    );
    return 1;
  }

  const result = checkLiveMigrationLog({ databaseUrl, journal: deps.journal, loggedWhens });
  if (!result.ok) {
    deps.log(`Refusing: ${result.reason}`);
    return 1;
  }

  if (result.pending.length === 0) {
    deps.log("Live already has every migration file: nothing new to run.");
    return 0;
  }
  deps.log(`Live will now run ${result.pending.length} new migration file(s), in this order:`);
  for (const entry of result.pending) deps.log(`  ${entry.tag}`);
  return 0;
}

// Drizzle's own log of what ran. created_at is the journal entry's `when`;
// it is a bigint column, which the driver returns as text.
async function readLoggedWhensFromDatabase(url: string): Promise<number[]> {
  const sql = postgres(url, { max: 1, connect_timeout: 20 });
  try {
    const rows = await sql<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations`;
    return rows.map((row) => Number(row.created_at));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function readJournal(): JournalEntry[] {
  const raw = readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8");
  const journal = JSON.parse(raw) as { entries: JournalEntry[] };
  return journal.entries.map(({ idx, when, tag }) => ({ idx, when, tag }));
}

// Only when run as a script — importing runGuard (the tests do) runs nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGuard({
    databaseUrl: process.env.DATABASE_URL,
    journal: readJournal(),
    readLoggedWhens: readLoggedWhensFromDatabase,
    // On GitHub, a refusal is also shown at the top of the run's page.
    log: (line) =>
      console.log(process.env.GITHUB_ACTIONS === "true" && line.startsWith("Refusing:") ? `::error::${line}` : line),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
