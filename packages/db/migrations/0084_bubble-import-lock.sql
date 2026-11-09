-- Workbook Task 28: once Ori is the live system, the Bubble importer must not
-- be able to run against it again. A --commit import REPLACES the business
-- data (it empties the trading-day, order, pick, company and login tables
-- first), and even a dry run holds write locks on those tables while it
-- works. One mistaken run after the switch-over would wipe production.
--
-- This table is the lock. The importer (packages/db/scripts/
-- import-from-bubble.ts) refuses to start — dry run or --commit — on a
-- database where it has a row. It is created empty, so nothing changes now;
-- after the final cutover, whoever runs it locks the importer with:
--
--   insert into public.bubble_import_lock (locked_by) values ('<name>, after the cutover');
--
-- and only by deleting that row, deliberately, can it run there again.
-- Safe to run again.

create table if not exists public.bubble_import_lock (
  locked_at timestamptz not null default now(),
  locked_by text not null
);

comment on table public.bubble_import_lock is
  'A row here = the Bubble importer refuses to run against this database (workbook Task 28). Insert one after the final cutover; it is meant to stay. Migration 0084.';

-- SECURITY: ALLOWS only the database owner — the person running the importer
-- or SQL in the dashboard — to read and change the lock. PROTECTS AGAINST any
-- app user, signed in or not, unlocking (or locking) the importer through the
-- API: row-level security is on with no policy, and the API roles get no
-- rights on the table at all. Not FORCEd, so the owner (who the importer
-- connects as) still reads it.
alter table public.bubble_import_lock enable row level security;
revoke all on table public.bubble_import_lock from public, anon, authenticated, service_role;
