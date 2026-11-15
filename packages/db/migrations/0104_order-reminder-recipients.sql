-- 0104 — a reminder can carry its list of people.
--
-- The office can choose which of a customer's people get the order reminder
-- (Bubble feature gap). Three changes:
--   1. notification_outbox.recipient_user_ids — an optional list of user ids on
--      the queued row. NULL = the company's usual routing (its WhatsApp group,
--      else every user with a number), exactly as today.
--   2. send_order_reminder(uuid, uuid[] default null) — takes the list, checks
--      it, and writes it on the queued row. A call with only the order id
--      behaves exactly as it did, so a browser tab loaded before the web
--      deploy keeps working.
--   3. resolve_outbox_dispatch — when the row carries a list, the message goes
--      privately to exactly those people, never to the group.
--
-- Run this BEFORE the web deploy. Today's site keeps working with it applied.
-- No whatsapp-dispatch redeploy: the dispatcher calls the same function with
-- the same arguments and result columns. Safe to run again.

-- 1. The column.
alter table public.notification_outbox
  add column if not exists recipient_user_ids uuid[];

comment on column public.notification_outbox.recipient_user_ids is
  'NULL = the recipient company''s usual routing (its WhatsApp group, else every user with a number). A list = exactly these users of recipient_company_id, privately, never the group. Written only by send_order_reminder (migration 0104).';

-- 2. send_order_reminder. The argument list changes, so the old one-argument
-- function is dropped first (a create-or-replace would leave both in place and
-- a call with only the order id would then be ambiguous).
drop function if exists public.send_order_reminder(uuid);

-- SECURITY: security invoker, so the caller's own row-level security applies on
-- top of the role check below. ALLOWS a backoffice user only. PROTECTS AGAINST
-- a customer, a grower, a signed-in account with no profile and a visitor who
-- is not signed in queueing WhatsApp messages to a company's people. The role
-- check is "is distinct from" (not "<>"): current_role() is NULL for a caller
-- with no profile, and "<>" is never true for NULL, so it let that caller past
-- (the trap 0076 closed for the definer functions).
create function public.send_order_reminder(p_daily_order_id uuid, p_recipient_user_ids uuid[] default null)
returns public.daily_orders
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order public.daily_orders;
  v_trade_date date;
  v_recipients uuid[];
begin
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select * into v_order from public.daily_orders where id = p_daily_order_id for update;
  if not found then
    raise exception 'NOT_FOUND: order % does not exist', p_daily_order_id using errcode = 'P0002';
  end if;

  if v_order.status = 'submitted' then
    raise exception 'INVALID_STATE: cannot send a reminder about an order that''s already been submitted' using errcode = 'P0007';
  end if;

  -- A list was given: send each person once, refuse an empty list, and refuse
  -- anyone who is not a user of this order's customer (a NULL entry counts as
  -- a stranger: it matches no profile).
  if p_recipient_user_ids is not null then
    v_recipients := array(select distinct x from unnest(p_recipient_user_ids) as t(x));
    if cardinality(v_recipients) = 0 then
      raise exception 'INVALID_INPUT: choose at least one recipient' using errcode = 'P0008';
    end if;
    if exists (
      select 1
      from unnest(v_recipients) as t(x)
      where x is null
         or not exists (
           select 1 from public.profiles p
           where p.user_id = x and p.company_id = v_order.customer_company_id
         )
    ) then
      raise exception 'INVALID_INPUT: a recipient is not a user of this customer' using errcode = 'P0008';
    end if;
  end if;

  select trade_date into v_trade_date from public.trading_days where id = v_order.trading_day_id;

  update public.daily_orders
  set reminder_sent_at = now()
  where id = p_daily_order_id
  returning * into v_order;

  insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload, recipient_user_ids)
  values (
    v_order.trading_day_id, 'customer', v_order.customer_company_id, 'order_reminder',
    jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb),
    v_recipients
  );

  return v_order;
end;
$$;

comment on function public.send_order_reminder(uuid, uuid[]) is
  'Backoffice-only. Stamps reminder_sent_at on the customer''s Daily Order and writes one notification_outbox row (template_key ''order_reminder'', gated at drain time by the global WhatsApp toggle only). With only the order id, the row uses the customer''s usual routing. With p_recipient_user_ids (migration 0104) the row carries the list (each person once) and the message goes privately to exactly those people. Raises 42501 for a caller who is not backoffice (including one with no profile), P0007 if the order has already been submitted, P0008 for an empty list or a user who is not a user of this customer.';

-- SECURITY: ALLOWS signed-in sessions and the service role to call it; the
-- role check inside still limits it to backoffice. PROTECTS AGAINST a visitor
-- who is not signed in (and PUBLIC) reaching it at all — they stop at
-- "permission denied" before the function runs.
revoke execute on function public.send_order_reminder(uuid, uuid[]) from public, anon;
grant execute on function public.send_order_reminder(uuid, uuid[]) to authenticated, service_role;

-- 3. resolve_outbox_dispatch: same signature, result columns and security as
-- 0102. A row that carries a list of users skips the group and goes to those
-- users only.
--
-- SECURITY: unchanged from 0081/0102 — security invoker, so the caller's own
-- row-level security applies. ALLOWS the dispatcher (service-role key) and a
-- backoffice session to resolve any row. PROTECTS AGAINST any other signed-in
-- user reading a composed message or other companies' phone numbers: their
-- read of notification_outbox finds no row, and the call stops at NOT_FOUND.
create or replace function public.resolve_outbox_dispatch(p_outbox_id uuid)
returns table(target text, is_group boolean, message text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.notification_outbox;
  v_company public.companies;
begin
  select * into v_row from public.notification_outbox where id = p_outbox_id;
  if not found then
    raise exception 'NOT_FOUND: notification_outbox row % does not exist', p_outbox_id using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.notification_templates where template_key = v_row.template_key) then
    raise exception 'NOT_FOUND: notification template % does not exist', v_row.template_key using errcode = 'P0002';
  end if;

  select * into v_company from public.companies where id = v_row.recipient_company_id;

  if v_row.recipient_user_ids is null
     and v_company.whatsapp_group_id is not null and v_company.whatsapp_group_id <> '' then
    -- A WhatsApp group: one message, addressed to the company by name.
    return query select v_company.whatsapp_group_id, true, public.compose_outbox_message(v_row, v_company.name);
  else
    -- Each user with a number Ori can message, by their first name. When the
    -- row carries a list of users (0104), only those users, and only while
    -- they still belong to the recipient company.
    return query
    select
      public.whatsapp_personal_number(p.phone_number),
      false,
      public.compose_outbox_message(v_row, split_part(p.display_name, ' ', 1))
    from public.profiles p
    where p.company_id = v_row.recipient_company_id
      and (v_row.recipient_user_ids is null or p.user_id = any(v_row.recipient_user_ids))
      and public.whatsapp_personal_number(p.phone_number) is not null
    order by p.user_id;
  end if;
end;
$$;

comment on function public.resolve_outbox_dispatch(uuid) is
  'Resolves one notification_outbox row into its actual send targets: one row (the bare WhatsApp group id, is_group = true) if the recipient company has whatsapp_group_id set, otherwise one row per user with a phone number on file (is_group = false, addressed by country code and number — whatsapp_personal_number, 0077), in user order. A row that carries recipient_user_ids (0104) never uses the group: it goes privately to exactly those users of the recipient company who have a number. A user whose number cannot be read as a phone number is skipped. The text is compose_outbox_message''s (Bubble''s wording and layouts, migration 0102): %FIRST_NAME% is the company''s name for a group, else the user''s first name. Raises P0002 if the outbox row or its template_key does not resolve.';
