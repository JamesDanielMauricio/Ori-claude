import { cp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { build, loadEnv } from "vite";

import { bundleVercelFunction } from "../../api/scripts/bundle-vercel-function.mjs";

// Builds the website and the API into one Vercel deployment, written in
// Vercel's Build Output API layout (.vercel/output), which Vercel serves
// exactly as written.
const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(webDir, ".vercel", "output");

// RELEASE GUARD: ALLOWS a release build only once every public setting the
// website needs is set, read exactly as Vite will read it for this build (the
// process environment first, then apps/web's .env files, production mode).
// PROTECTS AGAINST publishing a site that cannot reach Supabase: public-env.ts
// falls back to an empty value, so with either setting missing the build used
// to succeed and Vercel would serve an app that cannot sign anyone in or load
// anything (release workbook task 18). Checked before anything is deleted or
// built, so a stopped build leaves the previous output as it was.
const REQUIRED_PUBLIC_SETTINGS = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const publicEnv = loadEnv("production", webDir, "VITE_");
const missing = REQUIRED_PUBLIC_SETTINGS.filter((name) => !publicEnv[name]?.trim());
if (missing.length > 0) {
  process.stderr.write(
    `Release build stopped: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set, ` +
      "so the website could not reach Supabase.\n" +
      "Set the missing value in Vercel (Project Settings → Environment Variables, for this environment), " +
      "or in apps/web/.env.local for a build on your own machine, then build again.\n",
  );
  process.exit(1);
}

await rm(outputDir, { recursive: true, force: true });

// The API is served from this same address, so the website calls a relative
// "/trpc". It must be an empty string rather than unset: public-env.ts only
// falls back to localhost for a missing value (`??`).
process.env.VITE_API_URL = "";
// The deployment's commit, for anything that reports which code was running
// (a crash record, say). Empty outside Vercel.
process.env.VITE_APP_VERSION = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);
await build({ root: webDir });
await cp(join(webDir, "dist"), join(outputDir, "static"), { recursive: true });

await bundleVercelFunction(join(outputDir, "functions", "api.func"));

await writeFile(
  join(outputDir, "config.json"),
  JSON.stringify(
    {
      version: 3,
      routes: [
        // API paths go to the function; Fastify's router takes it from there.
        { src: "^/(trpc/.*|healthz)$", dest: "/api" },

        // The app shell is never stored by any cache. index.html is the only
        // file whose name doesn't change between builds — every asset under
        // /assets/ is content-hashed — so it is the single thing standing
        // between a browser and a new deployment. Serve a stale shell and the
        // browser goes on loading the previous build's asset names, which is
        // the "I have to hard refresh to see my deploy" symptom.
        //
        // Vercel's default for a static file is `public, max-age=0,
        // must-revalidate`, which *should* already be enough: it is stale
        // immediately, so a cache has to revalidate before reusing it. In
        // practice that was not reliably happening, and `no-store` removes
        // the question entirely — the browser is not permitted to keep a copy
        // at all, so a reload has nothing stale to reuse and must fetch. The
        // cost is the shell itself (~2.3 kB, ~1 kB gzipped) on each page
        // load, and no 304s for it; the hashed assets it names are still
        // cached normally, so this does not re-download the app.
        //
        // `continue: true` means "attach these headers, then keep routing" —
        // without it this rule would answer the request itself. Matching
        // anything that is not /assets/ covers both a direct hit on "/" and
        // every client-side route that falls through to the shell below.
        {
          src: "^/(?!assets/).*$",
          headers: { "cache-control": "no-store, no-cache, must-revalidate" },
          continue: true,
        },

        // Real files (index.html, /assets/...) are served as they are.
        { handle: "filesystem" },

        // A miss under /assets/ is a real 404, not the app shell.
        //
        // Without this, the catch-all below answers a request for a deleted
        // chunk with index.html and a 200 — so the browser is handed HTML
        // where it asked for JavaScript, and the import dies on a syntax
        // error that says nothing about the real cause. This happens on every
        // deploy to any tab that was already open: its build's hashed chunk
        // filenames no longer exist here. An honest 404 is what
        // src/lib/lazy-route.ts turns into a single automatic reload.
        { src: "^/assets/.*$", status: 404 },

        // Any other path is a client-side route, so it gets the app shell.
        { src: "^/.*$", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);
