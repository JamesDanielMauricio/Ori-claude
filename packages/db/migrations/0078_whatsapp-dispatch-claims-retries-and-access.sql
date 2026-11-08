-- Workbook task 16 (review findings ORI-007, ORI-019, ORI-020): the WhatsApp
-- queue is worked safely, retries wait, and staff can see what went wrong.
--
-- What was wrong
--   - Two dispatch runs could pick the same waiting message at once (the
--     10-minute safety-net schedule and an office nudge, say) and both send
--     it: rows were chosen by "not sent yet, under 5 tries" with nothing
--     marking a row as taken.
--   - A failed message was eligible again immediately, so a few quick nudges
--     could use up all five tries within a minute.
--   - A credential problem (a wrong or expired WhatsApp token) counted as a
--     failure of every message, so one outage could exhaust the whole queue.
--   - Nothing showed staff which messages failed, or why.
--   - The dispatcher's own table access rested on Supabase's automatic
--     grants: a project built without them stops at "permission denied for
--     notification_settings" before reading the queue.
--
-- What this migration adds (the dispatcher code that uses it ships with it;
-- see supabase/functions/whatsapp-dispatch)
--   - Claims. claim_outbox_rows() marks the rows it hands out (claimed_at,
--     claimed_by) inside one statement that skips rows another run holds, so
--     two runs never get the same row. A run that dies leaves its claim
--     behind; after 10 minutes — longer than a dispatch run may last — the
--     row can be claimed again.
--   - Waiting between tries. settle_outbox_row(…, 'failed') counts the try and
--     sets next_attempt_at: 2, 10, 30 and 60 minutes after tries 1-4; the
--     fifth failure is final. claim_outbox_rows() skips a row until then.
--   - Channel problems cost no try. settle_outbox_row(…, 'released') hands a
--     row back untouched, with the reason, when the problem is WhatsApp
--     itself (bad credentials, an unusable test phone) rather than this
--     message. record_dispatch_run() keeps the current problem in
--     notification_dispatch_status for the staff screen.
--   - The 12-hour rule (James, 2026-11-08). A message not delivered within 12
--     hours of being queued is no longer sent automatically — it shows as
--     "expired". Staff can still send it by hand (retry_outbox_row), which
--     starts a new 12-hour window from that moment.
--   - Skipped stays skipped. A message whose WhatsApp switch was off when its
--     turn came (0048) now carries skipped_at; nothing resends it, by hand or
--     otherwise. Existing skipped rows are marked from their "Skipped:" reason.
--   - outbox_delivery_status() is the one rule for a row's state — sent,
--     skipped, failed, expired, sending, retrying or waiting. The claim uses
--     it, and so does the staff view notification_deliveries.
--   - Explicit grants for the dispatcher (service_role) on exactly what it
--     reads and writes, and nothing on these tables for a signed-out caller.
--   - Recipients already delivered to (sent_targets, 0038) are never touched:
--     a retry sends only to the ones still missing.
--   - Stored errors no longer hold the WhatsApp token. A network error from
--     the sending call repeats the provider URL, which contains the token;
--     the new dispatcher strips it before saving, and this migration blanks
--     it out of every error already stored.
--
-- Accepted, as the workbook says: claims cannot make sending exactly-once.
-- If WhatsApp accepts a message and the run then dies before recording it,
-- the claim expires and that recipient can get the message a second time.
-- Recording each recipient the moment it is sent keeps that window to the
-- one message in flight.
--
-- Deploy order: run this BEFORE deploying the new whatsapp-dispatch (the new
-- code calls these functions; the one deployed today keeps working
-- unchanged after this runs), and before the web app that adds the delivery
-- screen. Safe to run again: every statement is if-not-exists,
-- create-or-replace or an idempotent update.

-- 1. New columns on the queue.
alter table public.notification_outbox
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by uuid,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists skipped_at timestamptz,
  add column if not exists retry_requested_at timestamptz,
  add column if not exists retry_requested_by uuid;

alter table public.notification_outbox
  drop constraint if exists notification_outbox_retry_requested_by_fkey,
  add constraint notification_outbox_retry_requested_by_fkey
    foreign key (retry_requested_by) references public.profiles(user_id) on delete set null;

comment on column public.notification_outbox.claimed_at is
  'When a dispatch run took this row (claim_outbox_rows). Null = nobody holds it. A claim older than 10 minutes belongs to a run that died and can be taken again.';
comment on column public.notification_outbox.claimed_by is
  'Which dispatch run holds the claim — a random id per run, so a run only settles rows it still holds.';
comment on column public.notification_outbox.next_attempt_at is
  'After a failed try: not before this moment (2/10/30/60 minutes after tries 1-4). Null = due now.';
comment on column public.notification_outbox.skipped_at is
  'Set when the row was abandoned because its WhatsApp switch was off when its turn came (0048). A skipped row is never sent, by hand or otherwise.';
comment on column public.notification_outbox.retry_requested_at is
  'When staff last pressed "send again" (retry_outbox_row). The 12-hour automatic-sending window counts from this, or from created_at if never pressed.';
comment on column public.notification_outbox.retry_requested_by is
  'Who pressed "send again" last. Set to null if that user is deleted.';

-- Rows skipped before this migration are recognisable by the reason 0048
-- wrote ("Skipped: WhatsApp was disabled …").
update public.notification_outbox
set skipped_at = coalesce(last_attempted_at, created_at)
where skipped_at is null
  and sent_at is null
  and last_error like 'Skipped:%';

-- The token inside a stored error: Green API's URL is
-- https://…/waInstance<id>/<method>/<token>. Keep the method, blank the rest.
update public.notification_outbox
set last_error = regexp_replace(last_error, 'waInstance[0-9]*/([A-Za-z]+)/[^[:space:]"'')]+', 'waInstance***/\1/***', 'g')
where last_error ~ 'waInstance[0-9]*/[A-Za-z]+/[^[:space:]"'')*]';

create index if not exists notification_outbox_unsent_idx
  on public.notification_outbox (created_at)
  where sent_at is null and skipped_at is null;

-- The dispatcher deployed today still abandons a switched-off row through
-- record_outbox_skipped (0048) until the new one is deployed. Same
-- signature, now also setting skipped_at, so a row skipped in between is
-- marked the same way.
--
-- SECURITY: security invoker, unchanged from 0048 — it ALLOWS the
-- dispatcher (service role) and backoffice sessions, and PROTECTS AGAINST
-- other signed-in users, whose update matches no row under
-- notification_outbox's backoffice-only policy.
create or replace function public.record_outbox_skipped(p_outbox_id uuid, p_max_attempts integer, p_reason text)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.notification_outbox
  set
    attempt_count = p_max_attempts,
    last_error = p_reason,
    last_attempted_at = now(),
    skipped_at = coalesce(skipped_at, now())
  where id = p_outbox_id;
$$;

-- 2. One rule for a row's state.
create or replace function public.outbox_delivery_status(o public.notification_outbox)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when o.sent_at is not null then 'sent'
    when o.skipped_at is not null then 'skipped'
    when o.attempt_count >= 5 then 'failed'
    when coalesce(o.retry_requested_at, o.created_at) <= now() - interval '12 hours' then 'expired'
    when o.claimed_at is not null and o.claimed_at > now() - interval '10 minutes' then 'sending'
    when o.attempt_count > 0 then 'retrying'
    else 'waiting'
  end
$$;

comment on function public.outbox_delivery_status(public.notification_outbox) is
  'A notification_outbox row''s state: sent; skipped (switch was off); failed (5 tries used); expired (not delivered within 12 hours of being queued or of staff''s last "send again"); sending (a run holds a fresh claim); retrying (tried and failed, tries left); waiting (not tried yet, or handed back because of a WhatsApp-wide problem). claim_outbox_rows hands out only waiting/retrying rows that are due.';

-- 3. The dispatcher's state, for the staff screen.
create table if not exists public.notification_dispatch_status (
  id boolean primary key default true check (id),
  last_run_at timestamptz,
  channel_problem text,
  channel_problem_since timestamptz
);

insert into public.notification_dispatch_status (id) values (true) on conflict (id) do nothing;

comment on table public.notification_dispatch_status is
  'Single row: when the WhatsApp dispatcher last ran, and the WhatsApp-wide problem it last hit (wrong token, no test phone…) with when it started. Cleared by the first run that delivers a message again.';

alter table public.notification_dispatch_status enable row level security;
alter table public.notification_dispatch_status force row level security;

-- SECURITY: ALLOWS signed-in backoffice staff to read the dispatcher's state
-- and (through record_dispatch_run, when a backoffice session runs the drain
-- in tests) to update it. PROTECTS AGAINST customers and growers reading
-- what is going wrong with the office's WhatsApp. The dispatcher itself uses
-- the service-role key, which bypasses row-level security.
drop policy if exists "notification_dispatch_status_backoffice" on public.notification_dispatch_status;
create policy "notification_dispatch_status_backoffice" on public.notification_dispatch_status
  for all
  to authenticated
  using ((select public.current_role()) = 'backoffice')
  with check ((select public.current_role()) = 'backoffice');

-- 4. Claim a batch.
--
-- SECURITY: security invoker, so the caller's own row-level security
-- decides which rows it can claim. That ALLOWS the dispatcher (service-role
-- key, bypasses RLS) and a backoffice session (notification_outbox's
-- backoffice-only policy, 0020) to work the queue. It PROTECTS AGAINST any
-- other signed-in user: their update matches no row, so they claim nothing.
-- Execute is also revoked from signed-out callers below.
create or replace function public.claim_outbox_rows(p_worker uuid, p_limit integer default 25)
returns table(id uuid, template_key text, sent_targets text[])
language sql
security invoker
set search_path = public
as $$
  with due as (
    select o.id
    from public.notification_outbox o
    where o.sent_at is null
      and o.skipped_at is null
      and public.outbox_delivery_status(o) in ('waiting', 'retrying')
      and (o.next_attempt_at is null or o.next_attempt_at <= now())
    order by o.created_at, o.id
    limit greatest(1, least(coalesce(p_limit, 25), 100))
    -- A row another run is claiming right now is passed over, not waited
    -- for; once that run commits, the row reads as "sending" and stays out.
    for update skip locked
  )
  update public.notification_outbox o
  set claimed_at = now(), claimed_by = p_worker
  from due
  where o.id = due.id
  returning o.id, o.template_key, o.sent_targets
$$;

comment on function public.claim_outbox_rows(uuid, integer) is
  'Hands one dispatch run (p_worker, a fresh random id per run) up to p_limit (max 100) due rows, oldest first, and marks them claimed so no other run gets them. Due = outbox_delivery_status waiting/retrying and next_attempt_at reached. Rows another run is claiming at the same moment are skipped.';

-- 5. Settle a claimed row.
--   sent     — every recipient has it: stamp sent_at (also for a run whose
--              claim expired meanwhile — the message did go out).
--   failed   — this message failed: count the try and set the wait.
--   released — WhatsApp itself is the problem: no try counted.
--   skipped  — its switch is off: never sent (0048's rule).
-- Apart from 'sent', a run can only settle a row it still holds.
--
-- SECURITY: security invoker, for the same reason as claim_outbox_rows: it
-- ALLOWS the dispatcher and backoffice sessions, and PROTECTS AGAINST other
-- signed-in users, whose update matches no row.
create or replace function public.settle_outbox_row(
  p_outbox_id uuid,
  p_worker uuid,
  p_outcome text,
  p_detail text default null
)
returns public.notification_outbox
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.notification_outbox;
  v_detail text := left(p_detail, 2000);
begin
  if p_outcome = 'sent' then
    update public.notification_outbox
    set sent_at = coalesce(sent_at, now()),
        last_attempted_at = now(),
        last_error = null,
        claimed_at = case when claimed_by = p_worker then null else claimed_at end,
        claimed_by = case when claimed_by = p_worker then null else claimed_by end
    where id = p_outbox_id
    returning * into v_row;
  elsif p_outcome = 'failed' then
    -- In an UPDATE, attempt_count on the right is the value before this try.
    update public.notification_outbox
    set attempt_count = attempt_count + 1,
        last_error = v_detail,
        last_attempted_at = now(),
        next_attempt_at = now() + case attempt_count + 1
                                    when 1 then interval '2 minutes'
                                    when 2 then interval '10 minutes'
                                    when 3 then interval '30 minutes'
                                    else interval '60 minutes'
                                  end,
        claimed_at = null,
        claimed_by = null
    where id = p_outbox_id and claimed_by = p_worker and sent_at is null
    returning * into v_row;
  elsif p_outcome = 'released' then
    update public.notification_outbox
    set last_error = coalesce(v_detail, last_error),
        claimed_at = null,
        claimed_by = null
    where id = p_outbox_id and claimed_by = p_worker and sent_at is null
    returning * into v_row;
  elsif p_outcome = 'skipped' then
    update public.notification_outbox
    set skipped_at = now(),
        last_error = v_detail,
        last_attempted_at = now(),
        claimed_at = null,
        claimed_by = null
    where id = p_outbox_id and claimed_by = p_worker and sent_at is null
    returning * into v_row;
  else
    raise exception 'INVALID_INPUT: outcome must be sent, failed, released or skipped, not %', p_outcome
      using errcode = '22023';
  end if;
  return v_row;
end;
$$;

comment on function public.settle_outbox_row(uuid, uuid, text, text) is
  'Records how a claimed row ended: sent (stamps sent_at), failed (counts the try, waits 2/10/30/60 minutes before the next), released (a WhatsApp-wide problem — no try counted) or skipped (switch off — never sent). Except for sent, only the run still holding the claim can settle the row; otherwise it returns null and changes nothing. sent_targets is never touched here.';

-- 6. Staff: send again.
--
-- SECURITY: ALLOWS only signed-in backoffice staff to put an unsent message
-- back in the queue. PROTECTS AGAINST anyone else forcing messages out —
-- including callers with no profile or no sign-in, whose NULL role
-- `is distinct from` refuses (0076). It is security invoker, so row-level
-- security (backoffice-only on notification_outbox) applies as well.
create or replace function public.retry_outbox_row(p_outbox_id uuid)
returns public.notification_outbox
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.notification_outbox;
begin
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select * into v_row from public.notification_outbox where id = p_outbox_id for update;
  if not found then
    raise exception 'NOT_FOUND: notification_outbox row % does not exist', p_outbox_id using errcode = 'P0002';
  end if;
  if public.outbox_delivery_status(v_row) = 'sent' then
    raise exception 'INVALID_STATE: this message was already sent' using errcode = 'P0007';
  end if;
  if public.outbox_delivery_status(v_row) = 'skipped' then
    raise exception 'INVALID_STATE: this message was skipped because its WhatsApp switch was off, and is not sent later'
      using errcode = 'P0007';
  end if;
  if public.outbox_delivery_status(v_row) = 'sending' then
    raise exception 'INVALID_STATE: this message is being sent right now' using errcode = 'P0007';
  end if;

  update public.notification_outbox
  set attempt_count = 0,
      next_attempt_at = null,
      last_error = null,
      retry_requested_at = now(),
      retry_requested_by = (select auth.uid())
  where id = p_outbox_id
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.retry_outbox_row(uuid) is
  'Backoffice-only "send again" for one unsent message: five fresh tries, due now, and a new 12-hour window from this moment. Recipients already delivered to (sent_targets) are kept, so only the missing ones are sent. Refuses a message that was sent, skipped, or is being sent right now (P0007).';

-- 7. The dispatcher reports each run.
--   p_channel_ok true  — a message went out: any WhatsApp-wide problem is over.
--   p_channel_ok false — WhatsApp itself failed: keep p_channel_problem, and
--                        when it started.
--   p_channel_ok null  — nothing was sent, so nothing is known: leave it.
--
-- SECURITY: security invoker — ALLOWS the dispatcher (service role) and a
-- backoffice session, through notification_dispatch_status's backoffice-only
-- policy. PROTECTS AGAINST any other signed-in user, whose update matches no
-- row.
create or replace function public.record_dispatch_run(p_channel_ok boolean, p_channel_problem text default null)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.notification_dispatch_status
  set last_run_at = now(),
      channel_problem = case
        when p_channel_ok is true then null
        when p_channel_ok is false then left(p_channel_problem, 2000)
        else channel_problem
      end,
      channel_problem_since = case
        when p_channel_ok is true then null
        when p_channel_ok is false then coalesce(channel_problem_since, now())
        else channel_problem_since
      end
  where id
$$;

comment on function public.record_dispatch_run(boolean, text) is
  'Called once at the end of every dispatch run: stamps last_run_at, and sets, keeps or clears the WhatsApp-wide problem the staff screen shows.';

-- 8. What staff see. security_invoker, so reading it is exactly as allowed
-- as reading notification_outbox itself (backoffice only). It shows how many
-- recipients have the message, never their numbers.
create or replace view public.notification_deliveries
with (security_invoker = true) as
select
  o.id,
  o.trading_day_id,
  td.trade_date,
  o.template_key,
  o.recipient_type,
  o.recipient_company_id,
  c.name as recipient_name,
  o.created_at,
  o.sent_at,
  o.attempt_count,
  o.last_error,
  o.last_attempted_at,
  o.next_attempt_at,
  o.retry_requested_at,
  coalesce(cardinality(o.sent_targets), 0) as delivered_count,
  public.outbox_delivery_status(o) as status
from public.notification_outbox o
left join public.companies c on c.id = o.recipient_company_id
left join public.trading_days td on td.id = o.trading_day_id;

comment on view public.notification_deliveries is
  'Staff view of the WhatsApp queue: one row per queued message with its recipient company, trading day, tries, last error and state (outbox_delivery_status). Reads through notification_outbox''s own backoffice-only row-level security (security_invoker).';

-- 9. Access.
--
-- SECURITY: the dispatcher (service_role) gets exactly what it reads and
-- writes, by name, instead of relying on the automatic grants a Supabase
-- project normally adds to new tables (ORI-007: a project built without
-- them stopped the dispatcher at "permission denied"). ALLOWS: reading the
-- WhatsApp switches and test phone, the templates, and the companies and
-- profiles a message is addressed to; claiming and updating queue rows; and
-- updating the run status. PROTECTS AGAINST nothing on its own — the
-- service-role key is the dispatcher's alone — but it keeps the
-- dispatcher's needs written down and minimal.
grant select on public.notification_settings to service_role;
grant select on public.notification_templates to service_role;
grant select, update on public.notification_outbox to service_role;
grant select on public.companies to service_role;
grant select on public.profiles to service_role;
grant select, update on public.notification_dispatch_status to service_role;
grant select on public.notification_deliveries to service_role;

-- SECURITY: ALLOWS signed-in users to reach the staff view and the status
-- row at all; row-level security then lets only backoffice see anything.
-- PROTECTS AGAINST nothing by itself — the backoffice-only policies above
-- and on notification_outbox are what keep customers and growers out.
grant select on public.notification_deliveries to authenticated;
grant select, update on public.notification_dispatch_status to authenticated;

-- SECURITY: ALLOWS only reading and updating the single status row, and only
-- reading the staff view. PROTECTS AGAINST the automatic grants a Supabase
-- project adds to every new table and view (insert, delete, everything) being
-- what decides: nobody — staff or the dispatcher — has any reason to add or
-- delete the status row, and the view is for reading.
revoke insert, delete, truncate on public.notification_dispatch_status from authenticated, service_role;
revoke insert, update, delete, truncate on public.notification_deliveries from authenticated, service_role;

-- SECURITY: ALLOWS no signed-out access to the WhatsApp queue, its
-- settings, its templates, its status or the staff view. PROTECTS AGAINST
-- anyone holding the public anon key reaching these tables: today
-- row-level security already returns them nothing, and this takes away the
-- table access underneath as well, so a mistaken future policy cannot open
-- them.
revoke all on public.notification_outbox from anon;
revoke all on public.notification_settings from anon;
revoke all on public.notification_templates from anon;
revoke all on public.notification_dispatch_status from anon;
revoke all on public.notification_deliveries from anon;

-- SECURITY: ALLOWS the dispatcher (service_role) and signed-in sessions to
-- call the queue functions; inside, row-level security lets only backoffice
-- touch a row. PROTECTS AGAINST signed-out callers: Postgres grants execute
-- on every new function to PUBLIC (and Supabase to anon), and these are
-- taken away, so the public anon key cannot call them at all.
revoke execute on function public.claim_outbox_rows(uuid, integer) from public, anon;
grant execute on function public.claim_outbox_rows(uuid, integer) to authenticated, service_role;
revoke execute on function public.settle_outbox_row(uuid, uuid, text, text) from public, anon;
grant execute on function public.settle_outbox_row(uuid, uuid, text, text) to authenticated, service_role;
revoke execute on function public.record_dispatch_run(boolean, text) from public, anon;
grant execute on function public.record_dispatch_run(boolean, text) to authenticated, service_role;
revoke execute on function public.resolve_outbox_dispatch(uuid) from public, anon;
grant execute on function public.resolve_outbox_dispatch(uuid) to authenticated, service_role;
revoke execute on function public.resolve_outbox_preview(uuid) from public, anon;
grant execute on function public.resolve_outbox_preview(uuid) to authenticated, service_role;
revoke execute on function public.record_outbox_target_sent(uuid, text, boolean) from public, anon;
grant execute on function public.record_outbox_target_sent(uuid, text, boolean) to authenticated, service_role;
revoke execute on function public.record_outbox_attempt(uuid, text) from public, anon;
grant execute on function public.record_outbox_attempt(uuid, text) to authenticated, service_role;
revoke execute on function public.record_outbox_skipped(uuid, integer, text) from public, anon;
grant execute on function public.record_outbox_skipped(uuid, integer, text) to authenticated, service_role;
revoke execute on function public.outbox_delivery_status(public.notification_outbox) from public, anon;
grant execute on function public.outbox_delivery_status(public.notification_outbox) to authenticated, service_role;

-- SECURITY: ALLOWS signed-in sessions to call "send again" — the function
-- itself then refuses everyone but backoffice. PROTECTS AGAINST signed-out
-- callers and the dispatcher: neither has any reason to press it.
revoke execute on function public.retry_outbox_row(uuid) from public, anon;
grant execute on function public.retry_outbox_row(uuid) to authenticated;
