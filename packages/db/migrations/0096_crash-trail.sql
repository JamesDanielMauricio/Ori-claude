-- CRASH TRAIL — a temporary debugging aid (2026-11-12), not part of the
-- business. The web app leaves one row here each time a screen crashes, so a
-- blank screen someone reports can be traced and reproduced. Each row holds
-- who it happened to, the screen, the error and where in the code it was
-- thrown, the browser, which deployment was running, and the last 20 things
-- the person did before it ("breadcrumbs": the screens they opened and the
-- controls they clicked, by the controls' labels — never what was typed).
--
-- To remove it, ask for "remove Crash Trail". A later migration then runs
--   drop table if exists public.crash_trail;
-- and the web app's crash-trail code goes with it: see
-- apps/web/src/crash-trail/README.md for every piece. They can go in any
-- order; nothing else depends on this table.
--
-- SECURITY: ALLOWS anyone who can reach the API — signed in or not, any role
-- — to ADD a crash record, as asked: a crash on the sign-in screen must be
-- recordable too. PROTECTS AGAINST a record naming someone else as the
-- person it happened to: user_id is either empty or the caller's own
-- (auth.uid()). Only backoffice can READ the records, since they hold screen
-- paths and the labels of what was clicked (company names among them).
-- Nobody can change or delete a record through the API, or set its id or
-- time. Each text field has a length limit and breadcrumbs at most 20
-- entries, so a row stays small. A flood of anonymous rows is possible in
-- principle — the API key is public by design — and accepted for a table
-- that is temporary and only ever read by the office.
--
-- Safe to run again; touches nothing else.

create table if not exists public.crash_trail (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users (id) on delete set null,
  user_name text check (char_length(user_name) <= 200),
  role text check (char_length(role) <= 40),
  screen text check (char_length(screen) <= 500),
  error text check (char_length(error) <= 2000),
  stack text check (char_length(stack) <= 20000),
  breadcrumbs jsonb not null default '[]'::jsonb check (
    case
      when jsonb_typeof(breadcrumbs) = 'array'
        then jsonb_array_length(breadcrumbs) <= 20 and octet_length(breadcrumbs::text) <= 20000
      else false
    end
  ),
  browser text check (char_length(browser) <= 500),
  app_version text check (char_length(app_version) <= 40)
);

comment on table public.crash_trail is
  'CRASH TRAIL (temporary, 2026-11-12): one row per screen crash in the web app — who, where, the error and the last 20 steps before it. Anyone may add a row (user_id empty or their own); only backoffice reads. Drop it when the debugging is done.';

create index if not exists crash_trail_created_at_idx on public.crash_trail (created_at desc);

alter table public.crash_trail enable row level security;

revoke all on table public.crash_trail from public, anon, authenticated;
-- Every column but id and created_at, which the database sets.
grant insert (user_id, user_name, role, screen, error, stack, breadcrumbs, browser, app_version)
  on table public.crash_trail to anon, authenticated;
grant select on table public.crash_trail to authenticated;

drop policy if exists "crash_trail_insert_anyone" on public.crash_trail;
create policy "crash_trail_insert_anyone" on public.crash_trail
  for insert
  to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));

drop policy if exists "crash_trail_select_backoffice" on public.crash_trail;
create policy "crash_trail_select_backoffice" on public.crash_trail
  for select
  to authenticated
  using ((select public.current_role()) = 'backoffice');
