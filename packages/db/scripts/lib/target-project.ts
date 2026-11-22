// Which Supabase project a data script is about to write, read from the two
// addresses it writes through: the database (DATABASE_URL) and the API that
// holds storage (SUPABASE_URL). Pure: no network.
//
// Why it is needed (2026-11-21): fill-from-bubble.ts reads the root .env, and
// a variable set in the shell wins over the .env one by one. The root .env is
// dev's since 2026-11-17, so a run meant for live with only some variables set
// in the shell would read the rest from dev's file — writing one project's
// database and the other's storage. And the database HOST cannot tell the two
// apart: dev and live sit on the same Tokyo pooler.

import { LIVE_PROJECT_REF } from "./live-migration-guard";

export const DEV_PROJECT_REF = "owjgzyxuldmgvwxnhrom";

export type TargetProject = { ref: string; label: "live" | "dev" | "other" };

// The project an address names, read the way live-migration-guard.ts reads
// it: the session pooler's user name (postgres.<ref>) or the direct host
// (db.<ref>.supabase.co) — never anywhere else in the address, such as the
// password.
function projectOfDatabaseUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const fromUser = /^postgres\.([a-z0-9]{20})$/.exec(parsed.username)?.[1];
  const fromHost = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(parsed.hostname)?.[1];
  return fromUser ?? fromHost ?? null;
}

// The project of https://<ref>.supabase.co.
function projectOfApiUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return /^([a-z0-9]{20})\.supabase\.co$/.exec(parsed.hostname)?.[1] ?? null;
}

const labelOf = (ref: string): TargetProject["label"] =>
  ref === LIVE_PROJECT_REF ? "live" : ref === DEV_PROJECT_REF ? "dev" : "other";

// SECURITY: ALLOWS a data script to run only when its database address and
// its storage address name the SAME Supabase project, and tells it which one
// (so the script can say "live" or "dev" before it writes). PROTECTS AGAINST
// a run that writes dev's database and live's storage, or the reverse —
// which a half-set shell over the root .env would otherwise do silently.
export function targetProject(databaseUrl: string, supabaseUrl: string): TargetProject {
  const databaseRef = projectOfDatabaseUrl(databaseUrl);
  const apiRef = projectOfApiUrl(supabaseUrl);
  if (!databaseRef)
    throw new Error(
      "DATABASE_URL does not name a Supabase project (postgres.<ref> or db.<ref>.supabase.co).",
    );
  if (!apiRef)
    throw new Error("SUPABASE_URL does not name a Supabase project (https://<ref>.supabase.co).");
  if (databaseRef !== apiRef) {
    throw new Error(
      `DATABASE_URL is the ${labelOf(databaseRef)} project (${databaseRef}) but SUPABASE_URL is the ${labelOf(apiRef)} project (${apiRef}). Set all three variables for one project. Nothing was run.`,
    );
  }
  return { ref: databaseRef, label: labelOf(databaseRef) };
}
