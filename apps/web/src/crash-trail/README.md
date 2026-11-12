# Crash Trail (temporary)

A debugging aid added on 2026-11-12, to trace a blank screen that couldn't be reproduced. It's
not part of the business.

**What it does.** While the app runs, it keeps the last 20 steps in the browser's memory: the
screens opened and the controls clicked, by their labels, never what was typed. When a screen
crashes, it saves one row to `public.crash_trail` with the user, the screen, the error, where in
the code it was thrown, the steps, the browser and the deployment, and the crash screen lists the
steps under "פרטים נוספים". Nothing else ever writes that table.

## How to remove it

Remove the pieces in any order. Nothing else depends on them, so the app keeps working at every
step.

1. Delete this folder, `apps/web/src/crash-trail/`.
2. In `apps/web/src/main.tsx`, delete the `CrashTrail` import and the `<CrashTrail />` line, with
   its comment.
3. In `packages/db/src/supabase-types.ts`, delete the `crash_trail` entry, which is marked
   `CRASH TRAIL`.
4. Delete `packages/domain/src/crash-trail.test.ts`. It skips itself once the table is gone, so
   forgetting it can't fail CI.
5. Add a migration that drops the table, then apply it on production:

   ```sql
   drop table if exists public.crash_trail;
   ```

The screen safety net (`components/shell/screen-error-boundary.tsx`) stays as it is. Crash Trail
only listened to its general crash hook (`onScreenCrash`), and with no listener the crash screen
is the same. `VITE_APP_VERSION` in `scripts/build-vercel.mjs` is general too and can stay.
