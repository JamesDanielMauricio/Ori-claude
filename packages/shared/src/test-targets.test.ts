import { describe, expect, it } from "vitest";

import {
  assertDisposableTestTargets,
  findUnsafeTestTargets,
  UnsafeTestTargetError,
} from "./test-targets";

// Pure configuration checks: the guard only reads the strings it is given, so
// none of these needs a network, a database or a running Supabase stack.

// Exactly what CI runs with (.github/workflows/ci.yml, playwright.config.ts).
const CI = {
  databaseUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  supabaseUrl: "http://127.0.0.1:54321",
  apiUrl: "http://localhost:4000",
  browserUrl: "http://localhost:3000",
};
// The shape of the root .env, which points at the hosted (production) project.
const HOSTED_DB =
  "postgresql://postgres.abcdefghijklmnopqrst:s3cret-Passw0rd@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres";
const HOSTED_SUPABASE = "https://abcdefghijklmnopqrst.supabase.co";

describe("assertDisposableTestTargets", () => {
  it("accepts the local stack CI uses", () => {
    expect(() => assertDisposableTestTargets(CI)).not.toThrow();
    expect(findUnsafeTestTargets(CI)).toEqual([]);
  });

  it("accepts every spelling of this machine", () => {
    for (const host of ["127.0.0.1", "localhost", "LOCALHOST", "127.0.0.2", "127.255.255.254"]) {
      expect(
        findUnsafeTestTargets({
          databaseUrl: `postgres://postgres:postgres@${host}:54322/postgres`,
          supabaseUrl: `https://${host}:54321`,
          apiUrl: `http://${host}:4000`,
          browserUrl: `http://${host}:3000/`,
        }),
        host,
      ).toEqual([]);
    }
    // IPv6 ::1 works for the web addresses...
    expect(
      findUnsafeTestTargets({
        ...CI,
        supabaseUrl: "http://[::1]:54321",
        apiUrl: "http://[::1]:4000",
        browserUrl: "http://[::1]:3000",
      }),
    ).toEqual([]);
    // ...but not in a connection string: postgres.js would read "[::1]" as the host "[".
    expect(
      findUnsafeTestTargets({ databaseUrl: "postgresql://postgres@[::1]:54322/postgres" }),
    ).toEqual(["DATABASE_URL uses an IPv6 address, which postgres.js cannot read — use 127.0.0.1"]);
  });

  it("refuses the hosted project the root .env points at", () => {
    expect(() =>
      assertDisposableTestTargets({ databaseUrl: HOSTED_DB, supabaseUrl: HOSTED_SUPABASE }),
    ).toThrow(UnsafeTestTargetError);
    expect(findUnsafeTestTargets({ databaseUrl: HOSTED_DB, supabaseUrl: HOSTED_SUPABASE })).toEqual(
      [
        "DATABASE_URL points at aws-0-ap-northeast-1.pooler.supabase.com:5432, not this machine",
        "SUPABASE_URL points at abcdefghijklmnopqrst.supabase.co, not this machine",
      ],
    );
  });

  it("refuses a mixed setup where only one target is local", () => {
    expect(findUnsafeTestTargets({ ...CI, databaseUrl: HOSTED_DB })).toHaveLength(1);
    expect(findUnsafeTestTargets({ ...CI, supabaseUrl: HOSTED_SUPABASE })).toHaveLength(1);
    expect(
      findUnsafeTestTargets({ ...CI, apiUrl: "https://ori-claude-web.vercel.app/api" }),
    ).toEqual(["the API server URL points at ori-claude-web.vercel.app, not this machine"]);
    expect(
      findUnsafeTestTargets({ ...CI, browserUrl: "https://ori-claude-web.vercel.app" }),
    ).toEqual(["the web app URL points at ori-claude-web.vercel.app, not this machine"]);
  });

  it("never shows the database password in its message", () => {
    let message = "";
    try {
      assertDisposableTestTargets({ databaseUrl: HOSTED_DB });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(
      /DATABASE_URL points at aws-0-ap-northeast-1\.pooler\.supabase\.com:5432/,
    );
    expect(message).not.toContain("s3cret-Passw0rd");
    expect(message).not.toContain("postgres.abcdefghijklmnopqrst");
  });

  it("refuses a missing or empty value instead of assuming a default", () => {
    expect(findUnsafeTestTargets({ databaseUrl: undefined })).toEqual(["DATABASE_URL is not set"]);
    expect(findUnsafeTestTargets({ databaseUrl: "  " })).toEqual(["DATABASE_URL is not set"]);
    // A key listed with no value is checked, not skipped.
    expect(findUnsafeTestTargets({ databaseUrl: CI.databaseUrl, supabaseUrl: undefined })).toEqual([
      "SUPABASE_URL is not set",
    ]);
    // A key left out is not this caller's concern.
    expect(findUnsafeTestTargets({ databaseUrl: CI.databaseUrl })).toEqual([]);
  });

  it("refuses malformed values", () => {
    const bad = (databaseUrl: string) => findUnsafeTestTargets({ databaseUrl });
    expect(bad("127.0.0.1:54322")).toEqual([
      "DATABASE_URL is not a postgres:// or postgresql:// connection string",
    ]);
    expect(bad("mysql://root@127.0.0.1/db")).toEqual([
      "DATABASE_URL is not a postgres:// or postgresql:// connection string",
    ]);
    expect(bad("postgresql://postgres@127.0.0.1:notaport/postgres")).toEqual([
      "DATABASE_URL is not a valid connection string",
    ]);
    // A broken %-escape in the host part (postgres.js would fail to decode it).
    expect(bad("postgresql://postgres@127.0.0.1%E0%A4%A/postgres")).toEqual([
      "DATABASE_URL is not a valid connection string",
    ]);
    expect(findUnsafeTestTargets({ ...CI, supabaseUrl: "not a url" })).toEqual([
      "SUPABASE_URL is not a valid URL",
    ]);
    expect(findUnsafeTestTargets({ ...CI, supabaseUrl: "ftp://127.0.0.1" })).toEqual([
      "SUPABASE_URL is not an http(s) URL",
    ]);
  });

  it("refuses a connection string with no host, which would fall back to PGHOST", () => {
    expect(findUnsafeTestTargets({ databaseUrl: "postgresql:///postgres" })).toEqual([
      "DATABASE_URL has no host (it would fall back to PGHOST)",
    ]);
    // With a user name but no host the string does not even parse — refused too.
    expect(
      findUnsafeTestTargets({ databaseUrl: "postgres://postgres:postgres@/postgres" }),
    ).toEqual(["DATABASE_URL is not a valid connection string"]);
  });

  it("refuses several hosts in one connection string, even when the first is local", () => {
    const multi = "lists more than one host (only a single local host is allowed)";
    expect(
      findUnsafeTestTargets({
        databaseUrl: "postgresql://u:p@127.0.0.1:54322,db.example.com:5432/postgres",
      }),
    ).toEqual([`DATABASE_URL ${multi}`]);
    // postgres.js decodes the host part before splitting it, and stops at the
    // first ? or / — not at # — so neither trick hides a second host.
    expect(
      findUnsafeTestTargets({
        databaseUrl: "postgresql://u:p@127.0.0.1%2Cdb.example.com/postgres",
      }),
    ).toEqual([`DATABASE_URL ${multi}`]);
    expect(
      findUnsafeTestTargets({
        databaseUrl: "postgresql://u:p@127.0.0.1#,db.example.com:5432/postgres",
      }),
    ).toEqual([`DATABASE_URL ${multi}`]);
  });

  it("refuses look-alikes of this machine", () => {
    for (const host of [
      "127.0.0.1.example.com",
      "localhost.example.com",
      "example.com",
      "0.0.0.0",
      "10.0.0.5",
      "192.168.1.10",
      "127.0.0.256",
      "[::2]",
    ]) {
      expect(
        findUnsafeTestTargets({ databaseUrl: `postgresql://postgres@${host}:5432/postgres` }),
        host,
      ).toHaveLength(1);
      expect(
        findUnsafeTestTargets({ ...CI, supabaseUrl: `http://${host}:54321` }),
        host,
      ).toHaveLength(1);
    }
    // User-info that looks like a local host does not make the real host local.
    expect(
      findUnsafeTestTargets({ databaseUrl: "postgresql://127.0.0.1@db.example.com/postgres" }),
    ).toEqual(["DATABASE_URL points at db.example.com, not this machine"]);
    expect(
      findUnsafeTestTargets({ ...CI, supabaseUrl: "http://127.0.0.1@example.com:54321" }),
    ).toEqual(["SUPABASE_URL points at example.com:54321, not this machine"]);
  });
});
