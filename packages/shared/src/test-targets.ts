/**
 * The guard every destructive test suite runs before it touches anything
 * (release workbook task 01, ORI-022).
 *
 * packages/domain, apps/api and apps/web's Playwright suite create and delete
 * real Auth users, write companies, orders and picks, and "park" the single
 * open trading day for the length of the run. That is only safe against a
 * throwaway local Supabase stack (`pnpm supabase start` — what CI starts). The
 * root .env, though, points DATABASE_URL and SUPABASE_URL at the hosted
 * project, which holds the real business. One `source .env` (or a value left
 * over in the shell) and a plain `pnpm test` would have run the whole suite
 * against production.
 *
 * Pure on purpose: no imports, no network, no database. It only reads the
 * strings it is given, so it can run in a test config file before anything
 * else loads, and its own tests need nothing running.
 */

/** Where a test run is about to connect. Leave a field out if the run does not use it. */
export interface TestTargets {
  /** The Postgres connection string the run's `db` client uses (DATABASE_URL). Always checked. */
  databaseUrl: string | undefined;
  /** The Supabase API (Auth + PostgREST) the run's clients call (SUPABASE_URL). */
  supabaseUrl?: string | undefined;
  /** The API server the browser suite starts and the app calls. */
  apiUrl?: string | undefined;
  /** The web app the browser suite opens. */
  browserUrl?: string | undefined;
}

export class UnsafeTestTargetError extends Error {
  constructor(problems: string[]) {
    super(
      [
        "Refusing to run tests: they may only connect to a throwaway Supabase stack on this machine",
        "(`pnpm supabase start`, 127.0.0.1). These suites create and delete users and change business",
        "data, so a hosted project — production — must never be the target.",
        ...problems.map((problem) => `  - ${problem}`),
        "If you sourced the root .env, its DATABASE_URL and SUPABASE_URL point at the hosted project:",
        "open a fresh terminal (or unset them) and start the local stack instead.",
      ].join("\n"),
    );
    this.name = "UnsafeTestTargetError";
  }
}

const LABELS: Record<keyof TestTargets, string> = {
  databaseUrl: "DATABASE_URL",
  supabaseUrl: "SUPABASE_URL",
  apiUrl: "the API server URL",
  browserUrl: "the web app URL",
};

/**
 * Throws UnsafeTestTargetError unless every target given points at this
 * machine. Call it before any connection, fixture or setup work.
 */
export function assertDisposableTestTargets(targets: TestTargets): void {
  const problems = findUnsafeTestTargets(targets);
  if (problems.length > 0) throw new UnsafeTestTargetError(problems);
}

/** The same check, returning one line per unsafe target instead of throwing. */
export function findUnsafeTestTargets(targets: TestTargets): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(LABELS) as Array<keyof TestTargets>) {
    // databaseUrl is always checked; the others only when the caller lists
    // them — a key passed with an undefined value still counts as listed.
    if (key !== "databaseUrl" && !(key in targets)) continue;
    const problem =
      key === "databaseUrl" ? checkDatabaseUrl(targets[key]) : checkHttpUrl(targets[key]);
    if (problem) problems.push(`${LABELS[key]} ${problem}`);
  }
  return problems;
}

// SECURITY: ALLOWS only addresses that cannot leave this machine: `localhost`,
// the 127.0.0.0/8 loopback range written as four plain numbers, and IPv6 ::1.
// PROTECTS AGAINST a test run reaching any other machine — above all the
// hosted Supabase project. Deliberately strict: a look-alike name such as
// 127.0.0.1.example.com or localhost.example.com, 0.0.0.0, a private network
// address or a shortened IP like 127.1 is refused, even where it might happen
// to reach this machine, because a guard that guesses is not a guard.
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

// Only the host and port are ever shown: a connection string carries the
// database password, which must never land in a terminal or a CI log.
function where(url: URL): string {
  return url.port ? `${url.hostname}:${url.port}` : url.hostname;
}

function checkDatabaseUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return "is not set";
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1]?.toLowerCase();
  if (scheme !== "postgres" && scheme !== "postgresql") {
    return "is not a postgres:// or postgresql:// connection string";
  }
  // postgres.js (packages/db) also accepts several hosts in one string
  // ("host1:5432,host2:5432") and connects to whichever answers. Read the host
  // part exactly the way it does (up to the first ? or /, after the first @,
  // percent-decoded), so a loopback first host cannot hide a hosted second.
  const authority = value.slice(value.indexOf("://") + 3).split(/[?/]/)[0] ?? "";
  let hosts: string;
  try {
    hosts = decodeURIComponent(authority.slice(authority.indexOf("@") + 1));
  } catch {
    return "is not a valid connection string";
  }
  if (hosts.includes(",")) return "lists more than one host (only a single local host is allowed)";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a valid connection string";
  }
  // An empty host makes postgres.js fall back to the PGHOST variable — which
  // could name any machine, so it is refused rather than followed.
  if (url.hostname === "") return "has no host (it would fall back to PGHOST)";
  if (!isLoopbackHost(url.hostname)) return `points at ${where(url)}, not this machine`;
  // postgres.js finds the port by splitting the host at ":", so it cannot use
  // an IPv6 address written in a connection string at all ([::1] becomes "[").
  // Refused, so the guard never approves a string the client reads differently.
  if (url.hostname.startsWith("["))
    return "uses an IPv6 address, which postgres.js cannot read — use 127.0.0.1";
  return null;
}

function checkHttpUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return "is not set";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "is not an http(s) URL";
  if (!isLoopbackHost(url.hostname)) return `points at ${where(url)}, not this machine`;
  return null;
}
