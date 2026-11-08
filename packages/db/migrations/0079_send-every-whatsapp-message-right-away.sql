-- James's rule (2026-11-09): every WhatsApp message goes out right after it
-- is queued — not at the next 10-minute safety-net run (0047), which until
-- now was the only thing that sent most of them (closing-day messages,
-- orders, picking updates, stock alerts, "the shop is open", "a new trading
-- day is open").
--
-- How: a trigger on notification_outbox — any statement that queues
-- messages makes the very same call the 10-minute schedule makes (it runs
-- the schedule's own command, so the address and key are always the same),
-- once per transaction. pg_net sends it only after the transaction commits,
-- so the dispatcher finds the messages waiting, and a save that fails asks
-- for nothing. The dispatcher then sends everything that is due, the same as
-- on a scheduled run (and, from this release, keeps going until the queue
-- is empty — supabase/functions/whatsapp-dispatch/handler.ts).
--
-- The 10-minute schedule stays: it picks up retries once their wait is over,
-- and is the safety net if a call does not arrive.
--
-- Where the schedule's key is not in Vault (the CI stack, a fresh project)
-- this does nothing, so a test run can never call the production dispatcher.
-- Nothing a user sends reaches the SQL that runs here.
--
-- No table changes. Works with the dispatcher already deployed; the next
-- deploy adds "keep going until the queue is empty". Safe to run again.

-- SECURITY: security definer, owned by postgres, because the call needs what
-- a user's session does not have — the schedule's job (pg_cron), its key in
-- Vault, and pg_net. ALLOWS exactly one thing: the dispatcher's own
-- 10-minute call, made once now. PROTECTS AGAINST a user reaching any of
-- those directly: the function takes no input, runs only the stored schedule
-- command (which only the database owner can write), and execute is revoked
-- from every API role below, so it cannot be called over the API to set the
-- dispatcher running on demand.
create or replace function public.request_whatsapp_dispatch_now()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command text;
begin
  -- Once per transaction is enough: one run sends everything that is due.
  if current_setting('ori.whatsapp_dispatch_requested', true) = 'yes' then
    return;
  end if;
  -- Only where the schedule is set up with its key (production) — read the
  -- way the schedule itself reads it.
  if not exists (select 1 from vault.decrypted_secrets where name = 'whatsapp_dispatch_service_role_key') then
    return;
  end if;
  select command into v_command from cron.job where jobname = 'whatsapp-dispatch-safety-net';
  if v_command is null then
    return;
  end if;
  perform set_config('ori.whatsapp_dispatch_requested', 'yes', true);
  execute v_command;
exception
  when others then
    -- Sending right away is a bonus: it must never stop a save. If it fails,
    -- the 10-minute run still sends the message.
    null;
end;
$$;

comment on function public.request_whatsapp_dispatch_now() is
  'Asks the WhatsApp dispatcher to run now — the same call the 10-minute safety-net schedule (0047) makes, once per transaction, sent by pg_net after the transaction commits. Does nothing where the schedule''s Vault key is not set up. Never raises. Not callable over the API.';

revoke execute on function public.request_whatsapp_dispatch_now() from public, anon, authenticated, service_role;

-- The trigger: once per statement that queued messages (and, through the
-- function above, once per transaction).
--
-- SECURITY: security definer for the same reason as above (it calls the
-- function above, which no API role may execute). ALLOWS only that call.
-- PROTECTS AGAINST nothing on its own — it reads nothing and takes no input.
create or replace function public.notification_outbox_send_right_away()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.request_whatsapp_dispatch_now();
  return null;
end;
$$;

revoke execute on function public.notification_outbox_send_right_away() from public, anon, authenticated, service_role;

drop trigger if exists notification_outbox_send_right_away on public.notification_outbox;
create trigger notification_outbox_send_right_away
  after insert on public.notification_outbox
  for each statement
  execute function public.notification_outbox_send_right_away();
