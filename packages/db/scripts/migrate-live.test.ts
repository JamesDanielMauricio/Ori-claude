import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// The entry point must never fail open: however it is started, it does its
// checks, and a refusal is exit code 1. (An entry that first asks "was I run
// directly?" can answer "no" — for example through a linked folder — and then
// silently do nothing and exit 0, letting the job carry on unguarded.)
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const entryPath = fileURLToPath(new URL("./migrate-live.ts", import.meta.url));

function startEntry(how: "run" | "imported") {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.GITHUB_ACTIONS;
  const args =
    how === "run"
      ? ["--import", "tsx", entryPath]
      : ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entryPath).href)})`];
  return spawnSync(process.execPath, args, { cwd: packageDir, env, encoding: "utf8", timeout: 60_000 });
}

describe("scripts/migrate-live.ts", () => {
  it("refuses with exit 1 when there is no address, whether run directly or imported", () => {
    for (const how of ["run", "imported"] as const) {
      const result = startEntry(how);
      expect(result.status, `${how}: ${result.stderr}`).toBe(1);
      expect(result.stdout, how).toContain("LIVE_DATABASE_URL");
    }
  }, 120_000);
});
