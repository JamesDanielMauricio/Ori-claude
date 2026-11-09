-- Workbook Tasks 25 and 26 (review issues 9 and 10).
--
-- Task 25 — James's decision (2026-11-09): completing a grower sends its
-- messages straight away, as Bubble does. In Bubble, the arrangement screen's
-- "complete" button sends the grower what was sold from its stock (Main
-- alert 8) and its transporter what to collect (Main alert 7). In Ori the
-- truck icon (set_pick_closed, 0062) only changed the pick's status, and both
-- messages waited for the end of the day (build_notification_outbox).
-- Now:
--   - closing a pick with the truck queues the grower's message and its
--     transporter's message in the same transaction (sent right away, 0079),
--     if anything has been arranged from that grower — and marks the pick
--     (daily_picks.completion_messaged_at);
--   - closing the day sends the end-of-day message only to growers whose pick
--     carries no such mark, so a completed grower is not messaged twice;
--   - reopening a pick clears the mark: its arrangement may change, so the
--     next completion — or the end of the day, if it is not completed again —
--     sends an up-to-date message. A message already sent cannot be taken
--     back; closing again sends a fresh one rather than staying silent.
--
-- Task 26: the transporter used to get the grower's own template ("here is
-- what was sold from your stock"), with no grower name and no pickup time.
-- It now gets its own template, close_arrangement_grower_transporter, naming
-- the grower (%COMPANY%) and the pickup time (%PICKUP_TIME%) — the grower's
-- pickup time for the day, or the grower's default if the pick has none yet.
-- The key starts with "close_arrangement_grower", so the dispatcher's existing
-- switch for grower closing messages covers it with no redeploy. Its text is
-- new; Bubble's own wording lives in the imported bubble_mainalert_7 template
-- and can replace it by editing the row.
--
-- Also (Task 29): Bubble's "Should not receive arrangement?" company setting
-- comes back as companies.no_arrangement_message. A grower with it set gets
-- no sale message (Bubble's Main alert 8 skips them); its transporter still
-- gets the pickup message. The importer carries the setting over from Bubble;
-- the Growers screen edits it (0082).
--
-- Rollout: nothing to deploy with it, any order. Safe to run again.

-- 0. Bubble's opt-out.
alter table public.companies add column if not exists no_arrangement_message boolean not null default false;

comment on column public.companies.no_arrangement_message is
  'Bubble''s "Should not receive arrangement?": when true, this grower is not sent the arrangement sale message (what was sold from its stock, and to whom) — neither at completion nor at the end of the day. Its transporter''s pickup message is unaffected. Migration 0081.';

-- 1. The mark.
alter table public.daily_picks add column if not exists completion_messaged_at timestamptz;

comment on column public.daily_picks.completion_messaged_at is
  'When closing this pick with the truck icon (set_pick_closed) queued the grower''s and transporter''s messages. Null = not messaged at completion: the end of the day messages this grower (build_notification_outbox). Cleared when the pick is reopened. Migration 0081.';

-- 2. The transporter's own message.
insert into public.notification_templates (template_key, channel, title, content, link)
values (
  'close_arrangement_grower_transporter',
  'whatsapp',
  'סחורה לאיסוף',
  '%FIRST_NAME% שלום,%NL%הסידור של %COMPANY% ליום המסחר %CURRENT_OPEN_BUSINESS_DAY% מוכן לאיסוף. שעת איסוף: %PICKUP_TIME%.%NL%הנה מה שנמכר ולמי:%NL%%NL%%ORDER_DETAILS%',
  null
)
on conflict (template_key) do nothing;

-- 3. One grower's sale messages: its own, and its transporter's.
--
-- SECURITY: security invoker, so the caller's own row-level security
-- applies to everything it reads and writes. ALLOWS backoffice staff — the
-- truck icon and the end of the day both run as them. PROTECTS AGAINST
-- anyone else using it to send WhatsApp messages: the role check refuses
-- every other caller up front (`is distinct from` also refuses a NULL role —
-- no profile, not signed in), and signed-out callers cannot execute it at all.
create or replace function public.queue_grower_sale_messages(p_trading_day_id uuid, p_grower_company_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_trade_date date;
  v_grower integer;
  v_transporter integer;
begin
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select trade_date into v_trade_date from public.trading_days where id = p_trading_day_id;

  -- The grower: same content as the end-of-day message (0052), unless the
  -- grower asked not to receive it (no_arrangement_message, Bubble's setting).
  insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload)
  select
    p_trading_day_id, 'grower', dp.grower_company_id, 'close_arrangement_grower',
    jsonb_build_object(
      'tradeDate', v_trade_date,
      'lines', jsonb_agg(jsonb_build_object(
        'familyName', pf.name,
        'varietyName', pv.name,
        'varietySizes', pv.sizes,
        'quantityPallets', ar.quantity_pallets,
        'customerCompanyName', cc.name
      ))
    )
  from public.arrangement_records ar
  join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  join public.companies gc on gc.id = dp.grower_company_id
  join public.product_varieties pv on pv.id = dpp.product_variety_id
  join public.product_families pf on pf.id = pv.family_id
  join public.companies cc on cc.id = ar.customer_company_id
  where dp.trading_day_id = p_trading_day_id
    and dp.grower_company_id = p_grower_company_id
    and ar.quantity_pallets > 0
    and not gc.no_arrangement_message
  group by dp.grower_company_id;
  get diagnostics v_grower = row_count;

  -- The transporter: its own template, naming the grower and the pickup time.
  insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload)
  select
    p_trading_day_id, 'transporter', gc.transporter_company_id, 'close_arrangement_grower_transporter',
    jsonb_build_object(
      'tradeDate', v_trade_date,
      'companyName', gc.name,
      'pickupTime', coalesce(to_char(coalesce(dp.pickup_time, gc.default_pickup_time), 'HH24:MI'), 'לא נקבעה'),
      'lines', jsonb_agg(jsonb_build_object(
        'familyName', pf.name,
        'varietyName', pv.name,
        'varietySizes', pv.sizes,
        'quantityPallets', ar.quantity_pallets,
        'customerCompanyName', cc.name
      ))
    )
  from public.arrangement_records ar
  join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  join public.companies gc on gc.id = dp.grower_company_id
  join public.product_varieties pv on pv.id = dpp.product_variety_id
  join public.product_families pf on pf.id = pv.family_id
  join public.companies cc on cc.id = ar.customer_company_id
  where dp.trading_day_id = p_trading_day_id
    and dp.grower_company_id = p_grower_company_id
    and ar.quantity_pallets > 0
    and gc.transporter_company_id is not null
  group by gc.id, gc.name, gc.transporter_company_id, dp.pickup_time, gc.default_pickup_time;
  get diagnostics v_transporter = row_count;

  return v_grower + v_transporter;
end;
$$;

comment on function public.queue_grower_sale_messages(uuid, uuid) is
  'Backoffice-only. Queues one grower''s sale messages for a trading day: close_arrangement_grower to the grower and close_arrangement_grower_transporter (naming the grower and its pickup time) to the grower''s transporter, if one is set — only when something has been arranged from that grower. Returns how many messages were queued (0, 1 or 2). Used by set_pick_closed (completion) and build_notification_outbox (end of day). Migration 0081.';

revoke execute on function public.queue_grower_sale_messages(uuid, uuid) from public, anon;
grant execute on function public.queue_grower_sale_messages(uuid, uuid) to authenticated;

-- 4. The truck icon: 0062's set_pick_closed, plus the messages and the mark.
-- Everything else is 0062's body unchanged.
--
-- SECURITY: unchanged from 0062 — ALLOWS a backoffice user to close or reopen
-- any pick whose trading day has not been closed. PROTECTS AGAINST a grower or
-- customer closing (and so locking) the distributor's picks, and against
-- rewriting a finished day. Security invoker: backoffice already has update
-- rights on daily_picks (0010), so it borrows nothing.
create or replace function public.set_pick_closed(p_daily_pick_id uuid, p_closed boolean)
returns public.daily_picks
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pick public.daily_picks;
  v_phase public.trading_day_phase;
  v_messaged boolean := false;
begin
  -- `is distinct from`, not `<>`: current_role() is NULL for a caller with no
  -- profile, and `NULL <> 'backoffice'` is NULL, which an IF treats as false —
  -- the check would let them through. `is distinct from` is true for NULL, so
  -- they are refused.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;
  if p_closed is null then
    raise exception 'INVALID_INPUT: p_closed must be true or false' using errcode = 'P0008';
  end if;
  select * into v_pick from public.daily_picks where id = p_daily_pick_id for update;
  if not found then
    raise exception 'NOT_FOUND: pick % does not exist', p_daily_pick_id using errcode = 'P0002';
  end if;
  select phase into v_phase from public.trading_days where id = v_pick.trading_day_id;
  if v_phase = 'closed' then
    raise exception 'INVALID_STATE: the trading day of pick % has ended — its picks can no longer be closed or reopened', p_daily_pick_id
      using errcode = 'P0007';
  end if;
  if (v_pick.status = 'closed') = p_closed then
    return v_pick;
  end if;

  -- 0081: completing a grower sends its messages now (nothing is queued if
  -- nothing has been arranged from it yet — the end of the day covers it).
  if p_closed then
    v_messaged := public.queue_grower_sale_messages(v_pick.trading_day_id, v_pick.grower_company_id) > 0;
  end if;

  update public.daily_picks
  set status = case
        when p_closed then 'closed'::public.daily_pick_status
        when v_pick.submitted_at is not null then 'submitted'::public.daily_pick_status
        else 'draft'::public.daily_pick_status
      end,
      -- Closing: stamped only if messages went out. Reopening: cleared.
      completion_messaged_at = case when v_messaged then now() else null end,
      updated_at = now()
  where id = p_daily_pick_id
  returning * into v_pick;
  if not found then
    raise exception 'FORBIDDEN: the pick could not be updated' using errcode = '42501';
  end if;
  return v_pick;
end;
$$;

comment on function public.set_pick_closed(uuid, boolean) is
  'Backoffice-only. Closes (p_closed = true) or reopens (false) one Daily Pick during a running trading day — the arrangement board''s truck icon. Closing sets status to closed and, if anything has been arranged from the grower, queues the grower''s and its transporter''s messages right away and stamps completion_messaged_at (0081); reopening restores submitted if the pick has a submitted_at and draft if not, and clears completion_messaged_at. A closed pick refuses further edits and reminders but can still be arranged against. Idempotent: asking for the state the pick already has changes nothing. Raises 42501 for a non-backoffice caller, P0008 for a null p_closed, P0002 if the pick does not exist, P0007 once its trading day has ended.';

-- 5. The end of the day: 0052's build_notification_outbox, with the grower
-- and transporter messages going through the shared step above, skipping
-- growers already messaged at completion. The customers' part is unchanged.
create or replace function public.build_notification_outbox(p_trading_day_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_can_see_prices boolean;
  v_trade_date date;
  v_customer_count integer;
  v_grower_count integer;
begin
  -- SECURITY: ALLOWS only backoffice staff (it runs inside close_arrangement).
  -- PROTECTS AGAINST anyone else writing WhatsApp messages to every customer,
  -- grower and transporter. `is distinct from` (0081, was `<>`) also refuses
  -- a NULL role — a signed-in account with no profile, or no sign-in.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select ds.can_see_prices, td.trade_date into v_can_see_prices, v_trade_date
  from public.daily_shops ds
  join public.trading_days td on td.id = ds.trading_day_id
  where ds.trading_day_id = p_trading_day_id;

  insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload)
  select
    p_trading_day_id, 'customer', ar.customer_company_id, 'close_arrangement_customer',
    jsonb_build_object(
      'tradeDate', v_trade_date,
      'canSeePrices', coalesce(v_can_see_prices, false),
      'lines', jsonb_agg(jsonb_build_object(
        'familyName', pf.name,
        'varietyName', pv.name,
        'varietySizes', pv.sizes,
        'quantityPallets', ar.quantity_pallets,
        'price', case when v_can_see_prices then ar.price else null end,
        'growerCompanyName', gc.name
      ))
    )
  from public.arrangement_records ar
  join public.daily_order_products dop on dop.id = ar.daily_order_product_id
  join public.daily_orders do2 on do2.id = dop.daily_order_id
  join public.product_varieties pv on pv.id = dop.product_variety_id
  join public.product_families pf on pf.id = pv.family_id
  join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
  join public.daily_picks dp on dp.id = dpp.daily_pick_id
  join public.companies gc on gc.id = dp.grower_company_id
  where do2.trading_day_id = p_trading_day_id
    and ar.quantity_pallets > 0
    and do2.status <> 'open'
  group by ar.customer_company_id;
  get diagnostics v_customer_count = row_count;

  -- Growers (and their transporters) not already messaged when the
  -- distributor completed them with the truck icon (0081).
  select coalesce(sum(public.queue_grower_sale_messages(p_trading_day_id, g.grower_company_id)), 0)
    into v_grower_count
  from (
    select distinct dp.grower_company_id
    from public.arrangement_records ar
    join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    where dp.trading_day_id = p_trading_day_id
      and ar.quantity_pallets > 0
      and dp.completion_messaged_at is null
  ) g;

  return v_customer_count + v_grower_count;
end;
$$;

-- 6. %PICKUP_TIME% in the composed text: 0077's resolve_outbox_dispatch and
-- resolve_outbox_preview, each with one more replacement at the end.
-- Everything else is 0077's body unchanged.
--
-- SECURITY: unchanged from 0077 — security invoker, so the caller's own
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
  v_template public.notification_templates;
  v_company public.companies;
  v_order_details text;
  v_trade_date text;
  v_company_name text;
  v_product_name text;
  v_product_overbooking text;
  v_pickup_time text;
  v_body text;
begin
  select * into v_row from public.notification_outbox where id = p_outbox_id;
  if not found then
    raise exception 'NOT_FOUND: notification_outbox row % does not exist', p_outbox_id using errcode = 'P0002';
  end if;

  select * into v_template from public.notification_templates where template_key = v_row.template_key;
  if not found then
    raise exception 'NOT_FOUND: notification template % does not exist', v_row.template_key using errcode = 'P0002';
  end if;

  select * into v_company from public.companies where id = v_row.recipient_company_id;
  v_trade_date := coalesce(v_row.payload ->> 'tradeDate', '');
  v_order_details := public.compose_order_details_text(v_row.payload);
  v_company_name := v_row.payload ->> 'companyName';
  v_product_name := v_row.payload ->> 'productName';
  v_product_overbooking := v_row.payload ->> 'productOverbooking';
  v_pickup_time := coalesce(v_row.payload ->> 'pickupTime', '');

  if v_company.whatsapp_group_id is not null and v_company.whatsapp_group_id <> '' then
    v_body := replace(public.substitute_template_placeholders(
      v_template.content, v_company.name, v_order_details, v_trade_date,
      v_company_name, v_product_name, v_product_overbooking
    ), '%PICKUP_TIME%', v_pickup_time);
    if v_template.link is not null then
      v_body := v_body || chr(10) || v_template.link;
    end if;
    return query select v_company.whatsapp_group_id, true, v_body;
  else
    return query
    select
      public.whatsapp_personal_number(p.phone_number),
      false,
      replace(public.substitute_template_placeholders(
        v_template.content, split_part(p.display_name, ' ', 1), v_order_details, v_trade_date,
        v_company_name, v_product_name, v_product_overbooking
      ), '%PICKUP_TIME%', v_pickup_time) || case when v_template.link is not null then chr(10) || v_template.link else '' end
    from public.profiles p
    where p.company_id = v_row.recipient_company_id
      and public.whatsapp_personal_number(p.phone_number) is not null
    order by p.user_id;
  end if;
end;
$$;

create or replace function public.resolve_outbox_preview(p_outbox_id uuid)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.notification_outbox;
  v_template public.notification_templates;
  v_company public.companies;
  v_body text;
begin
  select * into v_row from public.notification_outbox where id = p_outbox_id;
  if not found then
    raise exception 'NOT_FOUND: notification_outbox row % does not exist', p_outbox_id using errcode = 'P0002';
  end if;

  select * into v_template from public.notification_templates where template_key = v_row.template_key;
  if not found then
    raise exception 'NOT_FOUND: notification template % does not exist', v_row.template_key using errcode = 'P0002';
  end if;

  select * into v_company from public.companies where id = v_row.recipient_company_id;

  v_body := replace(public.substitute_template_placeholders(
    v_template.content,
    v_company.name,
    public.compose_order_details_text(v_row.payload),
    coalesce(v_row.payload ->> 'tradeDate', ''),
    v_row.payload ->> 'companyName',
    v_row.payload ->> 'productName',
    v_row.payload ->> 'productOverbooking'
  ), '%PICKUP_TIME%', coalesce(v_row.payload ->> 'pickupTime', ''));
  if v_template.link is not null then
    v_body := v_body || chr(10) || v_template.link;
  end if;

  return v_body;
end;
$$;
