import { lazy, type ComponentType } from "react";

// Every screen in app-routes.tsx is code-split, so the browser fetches a
// route's JavaScript chunk the first time you navigate to it — not at
// startup. Vite gives each chunk a content hash in its filename
// (products-C7xK2p.js), and every Vercel deployment is its own immutable
// filesystem: the moment a new deployment goes live, the *previous* build's
// chunk filenames stop existing.
//
// That is the "I had to hard refresh" bug. A tab left open across a deploy is
// still running the old build's code, holding the old chunk names. The next
// navigation asks for a file that the live deployment no longer has, the
// import rejects, and because nothing catches it React unmounts the tree and
// leaves a blank page — until the user reloads by hand and picks up the new
// index.html, which names the new chunks.
//
// The fix is to treat a failed chunk fetch as "this tab is running a build
// that no longer exists" and reload once, which is exactly the hard refresh
// the user was doing manually.

// Per-tab, not per-browser: sessionStorage is scoped to this tab and survives
// the reload we are about to trigger, which is precisely the lifetime we want
// to remember "I already tried this". localStorage would leak the flag into
// every other tab and outlive the problem.
const RELOAD_GUARD_KEY = "ori-chunk-reload";

// How long a reload counts as "already tried". Long enough to cover the
// reloaded page getting back to the same screen (the auth read, then the
// layout's chunk, then the screen's), short enough that a later deployment in
// this same long-lived tab gets its own reload.
export const RELOAD_GUARD_MS = 60_000;

// Pure, for lazy-route.test.ts: `stored` is the guard's value (when the last
// reload happened), `now` the current time.
//
// Time-bounded rather than cleared by the next chunk that loads: a screen is
// nested in a layout, and the layout's chunk loading in the reloaded page
// cleared the guard before the screen's chunk failed again — so a screen whose
// chunk always fails reloaded the tab forever.
export function reloadedRecently(stored: string | null, now: number): boolean {
  const elapsed = now - Number(stored);
  return stored !== null && elapsed >= 0 && elapsed < RELOAD_GUARD_MS;
}

// Whether this tab has already reloaded for a failed chunk. The guard is what
// stops a reload loop: if the chunk is still unreachable after a reload, the
// cause is not a stale build (offline, a broken deployment) and reloading
// again would just spin.
function hasAlreadyReloaded(): boolean {
  try {
    return reloadedRecently(window.sessionStorage.getItem(RELOAD_GUARD_KEY), Date.now());
  } catch {
    // sessionStorage can throw outright (blocked site data, some private
    // modes). Without it we cannot tell a first failure from a repeat, so we
    // answer "yes" — surfacing the error is safe, a reload loop is not.
    return true;
  }
}

function rememberReload() {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // Nothing to do: hasAlreadyReloaded() fails closed for the same reason.
  }
}

// Drop-in replacement for React.lazy for route-level screens (all of which
// are rendered without props, hence the bare ComponentType).
export function lazyRoute(load: () => Promise<{ default: ComponentType }>) {
  return lazy(async () => {
    try {
      return await load();
    } catch (error) {
      if (hasAlreadyReloaded()) throw error;
      rememberReload();
      window.location.reload();
      // The page is being replaced. Never settling leaves <Suspense> showing
      // its fallback for the last moments of this document, instead of
      // flashing an error for a tree that is about to be thrown away.
      return new Promise<never>(() => {});
    }
  });
}
