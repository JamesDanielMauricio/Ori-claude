// Run by the migrate-live job (.github/workflows/migrate-live.yml) on every
// push to main, with DATABASE_URL = the LIVE_DATABASE_URL secret:
//
//   pnpm --filter @ori/db db:migrate-live
//
// It checks live's migration log, runs the new migration files on live, and
// checks they were recorded — see scripts/lib/migrate-live.ts. Exit 0: live
// has every file. Exit 1: refused or failed, and live is unchanged.
//
// This file runs its work unconditionally, on purpose: an entry point that
// first checks "was I started directly?" can wrongly answer no, then do
// nothing and exit 0 — letting the job pass without any check (fail open).
// Here, if it starts at all, it checks; if it cannot start, the step fails.
// Nothing imports this file; the tests import scripts/lib/migrate-live.ts.

import { fileURLToPath } from "node:url";

import { connectToLive, describeDatabaseError, migrateLive, readFileHashes, readJournal } from "./lib/migrate-live";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const journal = readJournal(migrationsFolder);

migrateLive({
  databaseUrl: process.env.DATABASE_URL,
  journal,
  fileHashes: readFileHashes(migrationsFolder, journal),
  connect: (url) => connectToLive(url, migrationsFolder),
  // On GitHub, a refusal or failure is also shown at the top of the run's page.
  log: (line) =>
    console.log(process.env.GITHUB_ACTIONS === "true" && /^(Refusing|Failed):/.test(line) ? `::error::${line}` : line),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`Failed: ${describeDatabaseError(error)}`);
    process.exitCode = 1;
  },
);
