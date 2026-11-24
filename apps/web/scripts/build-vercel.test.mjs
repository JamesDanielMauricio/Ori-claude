import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "build-vercel.mjs");

// Runs the release build the way Vercel does, with these two settings. A value
// set here — even an empty one — wins over apps/web's own .env files (Vite
// reads the process environment first), so the result is the same on every
// machine, and in CI.
function releaseBuild(settings) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ...settings },
    encoding: "utf8",
    timeout: 120_000,
  });
}

// Release workbook task 18: without these two settings the website cannot
// reach Supabase, yet the build used to succeed and publish it anyway.
describe("the release build (build-vercel.mjs)", () => {
  it("stops when the Supabase address is not set, and names only that setting", () => {
    const run = releaseBuild({
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_ANON_KEY: "a-publishable-key",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("VITE_SUPABASE_URL");
    expect(run.stderr).not.toContain("VITE_SUPABASE_ANON_KEY");
  }, 120_000);

  it("names every missing setting, and counts a blank value as missing", () => {
    const run = releaseBuild({ VITE_SUPABASE_URL: "   ", VITE_SUPABASE_ANON_KEY: "" });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("VITE_SUPABASE_URL");
    expect(run.stderr).toContain("VITE_SUPABASE_ANON_KEY");
  }, 120_000);
});
