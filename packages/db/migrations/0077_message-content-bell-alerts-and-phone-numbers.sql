-- Workbook task 15 (review findings ORI-017, ORI-018): messages say what
-- they are about, closing the day puts the bell alerts back, and phone
-- numbers are kept in one form that WhatsApp can actually reach.
--
-- 1. Company and product names were missing from four messages.
--    0031 taught resolve_outbox_dispatch to pass three more values into the
--    template — the company a message is about (%COMPANY%), the product
--    (%PRODUCT_NAME%) and the overbooking left (%PRODUCT_OVERBOOKING%).
--    0053 then rebuilt the function from 0024's older text and dropped them,
--    so since then "%COMPANY% שלחו הזמנה…", "%COMPANY% עדכן/ה את הערכת
--    הקטיף…" and both stock alerts reach the office with the name blank.
--    The dev preview (resolve_outbox_preview, 0046) never passed them at all.
--    Both now pass all seven values.
--
-- 2. Closing the day stopped creating the bell alerts.
--    0024 made close_arrangement call build_arrangement_alerts ("the
--    arrangement closed — N pallets", for every user of each customer and
--    grower that took part). 0043 rebuilt close_arrangement for the pickup
--    time and left that call out, and 0044/0065 carried the gap on, so no
--    such alert has been created since. The call is back, inside the same
--    transaction as before: if any later step fails, the alerts roll back
--    with the rest of the close. build_arrangement_alerts itself now never
--    gives the same person the same day's alert twice, even when called
--    again by hand, and holds the day's row lock while it checks.
--
-- 3. Phone numbers. James's rule (2026-11-09): Israeli numbers, stored as
--    local digits — 0501234567 — and foreign numbers too, written with + and
--    their country code and stored that way — +12125551234. Until now
--    profiles.phone_number was saved exactly as typed, and the queued
--    dispatch built the WhatsApp address as "972" + the text without its
--    first zero, so "050-123 4567" became an address that cannot exist (and
--    a foreign number could never be reached). Now:
--      - normalize_phone_number() is the rule in SQL. It mirrors
--        packages/shared/src/phone.ts exactly; packages/shared/src/
--        phone-cases.json holds the examples both are tested against.
--      - every save of a profile's phone number (and of the dev test phone in
--        notification_settings) is tidied into that form, and anything that
--        is not a phone number Ori can message is refused with a Hebrew
--        message;
--      - the dispatch addresses a person through whatsapp_personal_number(),
--        which reads old, untidied values the same way, and skips a number it
--        cannot read instead of sending to an address that cannot exist.
--        WhatsApp group ids are separate and pass through unchanged.
--    Numbers already stored are NOT rewritten here: an untidied but valid
--    one still dispatches correctly, and is tidied the next time it is
--    saved. A number that is already invalid is left as it is, so saving a
--    user's other fields keeps working.
--
-- Nothing here changes a table's columns, and the hand-deployed
-- whatsapp-dispatch function calls both resolve functions exactly as
-- before, so this can run before or after any deploy. Every statement is
-- create-or-replace or drop-then-create, so it is safe to run again.

-- 3a. The phone rule (James, 2026-11-09): Israeli numbers, and foreign ones
-- too. Step by step it is packages/shared/src/phone.ts, where the reason for
-- each step is written; packages/shared/src/phone-cases.json holds the
-- examples both are tested against.
--   - Allowed around the digits: spaces (also the no-break space), dashes
--     (also the U+2010-U+2015 family), + ( ) . / and the bidi marks Hebrew
--     interfaces wrap around a pasted number (U+200E, U+200F, U+202A-U+202E,
--     U+2066-U+2069) — written below as chr() codes, so no invisible
--     character sits in this file. Letters are not allowed: "050-1234567
--     בבית" is refused rather than guessed at.
--   - Written with + or 00 in front, a number carries its country code:
--     +972 is Israeli; anything else is foreign and is kept as + and 7 to 15
--     digits (the international standard, E.164). "(0)" in such a number is
--     the trunk zero dropped when dialling from abroad, and goes.
--   - Written without one, a number is Israeli. A bare "972…" counts as the
--     country code only when a whole Israeli number follows it: "97212345"
--     is the landline 09-7212345 typed without its zero.
--   - An Israeli number is stored as local digits with its zero: 0501234567.
create or replace function public.normalize_phone_number(p_input text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_allowed constant text := '0123456789 +()./-'
    || chr(160)                                                                    -- no-break space
    || chr(8208) || chr(8209) || chr(8210) || chr(8211) || chr(8212) || chr(8213) -- dashes
    || chr(8206) || chr(8207)                                                      -- LRM, RLM
    || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)               -- LRE, RLE, PDF, LRO, RLO
    || chr(8294) || chr(8295) || chr(8296) || chr(8297);                           -- LRI, RLI, FSI, PDI
  v_compact text;
  v_international boolean;
  v_digits text;
  v_full text;
  v_local text;
begin
  if p_input is null or p_input = '' then
    return null;
  end if;
  -- Anything but digits and the allowed characters — a letter, say: refused.
  if translate(p_input, v_allowed, '') <> '' then
    return null;
  end if;
  -- Digits and "+" only. A "+" anywhere but in front is not a phone number.
  v_compact := regexp_replace(p_input, '[^0-9+]', '', 'g');
  if strpos(substr(v_compact, 2), '+') > 0 then
    return null;
  end if;
  v_international := v_compact like '+%' or v_compact like '00%';
  v_digits := regexp_replace(
    case when v_international then replace(p_input, '(0)', '') else p_input end,
    '[^0-9]', '', 'g'
  );
  if v_digits = '' then
    return null;
  end if;

  -- The number with its country code, when it was written with one.
  if v_compact like '+%' then
    v_full := v_digits;
  elsif v_digits like '00%' then
    v_full := substr(v_digits, 3);
  elsif v_digits like '972%' and length(v_digits) >= 11 then
    v_full := v_digits;
  end if;

  if v_full is not null and v_full not like '972%' then
    return case when v_full ~ '^[1-9][0-9]{6,14}$' then '+' || v_full end;
  end if;

  -- Israeli: after +972 / 00972 / 972, or written locally. "+972 (0)50…" and
  -- "050…" keep their zero; "+972 50…" and "50…" get one.
  v_local := case when v_full is not null then substr(v_full, 4) else v_digits end;
  if v_local not like '0%' then
    v_local := '0' || v_local;
  end if;
  return case when v_local ~ '^0([23489][0-9]{7}|[57][0-9]{8})$' then v_local end;
end;
$$;

comment on function public.normalize_phone_number(text) is
  'The stored form of a phone number, or null when the input is not one Ori can message: an Israeli number as local digits with its leading zero (0501234567, 031234567); a foreign number — which must be written with + or 00 and its country code — as + and 7-15 digits (+12125551234). A number written without a country code is read as Israeli. Mirrors packages/shared/src/phone.ts exactly (shared examples: packages/shared/src/phone-cases.json). Pure — reads no table.';

-- A person's WhatsApp address: the country code and number, or null.
create or replace function public.whatsapp_personal_number(p_phone text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when s.stored like '+%' then substr(s.stored, 2) else '972' || substr(s.stored, 2) end
  from (select public.normalize_phone_number(p_phone) as stored) s
$$;

comment on function public.whatsapp_personal_number(text) is
  'A person''s WhatsApp address (Green API appends @c.us): the country code and number — 972 + a stored Israeli number without its zero, or a stored foreign number without its + — or null when the number is not one Ori can message. Pure — reads no table.';

-- 3b. Every save of a profile's phone number goes through the rule.
-- Only the value being written is judged: an old, already-invalid number
-- that is saved back unchanged is left alone, so a save of the user's other
-- fields (which re-sends the number) is not refused for it.
create or replace function public.profiles_tidy_phone_number()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_tidy text;
begin
  if new.phone_number is null or btrim(new.phone_number) = '' then
    new.phone_number := null;
    return new;
  end if;
  v_tidy := public.normalize_phone_number(new.phone_number);
  if v_tidy is not null then
    new.phone_number := v_tidy;
  elsif tg_op = 'INSERT' or new.phone_number is distinct from old.phone_number then
    raise exception 'INVALID_PHONE: מספר הטלפון אינו תקין. יש להזין מספר ישראלי (למשל 050-1234567) או מספר מחו״ל עם + וקידומת המדינה.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_tidy_phone_number on public.profiles;
create trigger profiles_tidy_phone_number
  before insert or update of phone_number on public.profiles
  for each row execute function public.profiles_tidy_phone_number();

-- The dev test phone (notification_settings.whatsapp_dev_override_phone,
-- 0045), where every dev-mode message goes: same rule, same form.
create or replace function public.notification_settings_tidy_dev_phone()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_tidy text;
begin
  if new.whatsapp_dev_override_phone is null or btrim(new.whatsapp_dev_override_phone) = '' then
    new.whatsapp_dev_override_phone := null;
    return new;
  end if;
  v_tidy := public.normalize_phone_number(new.whatsapp_dev_override_phone);
  if v_tidy is not null then
    new.whatsapp_dev_override_phone := v_tidy;
  elsif tg_op = 'INSERT' or new.whatsapp_dev_override_phone is distinct from old.whatsapp_dev_override_phone then
    raise exception 'INVALID_PHONE: מספר הטלפון אינו תקין. יש להזין מספר ישראלי (למשל 050-1234567) או מספר מחו״ל עם + וקידומת המדינה.'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists notification_settings_tidy_dev_phone on public.notification_settings;
create trigger notification_settings_tidy_dev_phone
  before insert or update of whatsapp_dev_override_phone on public.notification_settings
  for each row execute function public.notification_settings_tidy_dev_phone();

-- 1 + 3c. resolve_outbox_dispatch: all seven template values, and a person
-- is addressed through the phone rule. Same signature and result columns as
-- 0053, so create-or-replace keeps its grants and the deployed dispatcher
-- reads it unchanged. The per-person rows now come in a fixed order, so two
-- passes over the same row list its recipients the same way.
--
-- SECURITY: still security invoker, as 0024/0054 explain — it runs with the
-- caller's own row-level security. That ALLOWS the dispatcher (service-role
-- key) and a backoffice session to resolve any row. It PROTECTS AGAINST any
-- other signed-in user reading a composed message or other companies' phone
-- numbers: their read of notification_outbox finds no row, and the call
-- stops at NOT_FOUND before it reaches a template, company or profile.
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
  -- The third party a message is ABOUT (never the recipient) and the
  -- product a stock alert is about — written into the payload by the
  -- functions that queue those messages (0031 onwards).
  v_company_name := v_row.payload ->> 'companyName';
  v_product_name := v_row.payload ->> 'productName';
  v_product_overbooking := v_row.payload ->> 'productOverbooking';

  if v_company.whatsapp_group_id is not null and v_company.whatsapp_group_id <> '' then
    v_body := public.substitute_template_placeholders(
      v_template.content, v_company.name, v_order_details, v_trade_date,
      v_company_name, v_product_name, v_product_overbooking
    );
    if v_template.link is not null then
      v_body := v_body || chr(10) || v_template.link;
    end if;
    return query select v_company.whatsapp_group_id, true, v_body;
  else
    return query
    select
      public.whatsapp_personal_number(p.phone_number),
      false,
      public.substitute_template_placeholders(
        v_template.content, split_part(p.display_name, ' ', 1), v_order_details, v_trade_date,
        v_company_name, v_product_name, v_product_overbooking
      ) || case when v_template.link is not null then chr(10) || v_template.link else '' end
    from public.profiles p
    where p.company_id = v_row.recipient_company_id
      and public.whatsapp_personal_number(p.phone_number) is not null
    order by p.user_id;
  end if;
end;
$$;

comment on function public.resolve_outbox_dispatch(uuid) is
  'Resolves one notification_outbox row into its actual send targets: one row (the bare WhatsApp group id, is_group = true) if the recipient company has whatsapp_group_id set, otherwise one row per user with a phone number on file (is_group = false, addressed by country code and number — whatsapp_personal_number, 0077), in user order. A user whose number cannot be read as a phone number is skipped. Each message is composed via substitute_template_placeholders with all seven values (recipient name, order details, trade date, and the payload''s companyName/productName/productOverbooking). Raises P0002 if the outbox row or its template_key does not resolve.';

-- 1. The dev preview gets the same seven values, so a dev test shows the
-- same text a real recipient would get.
--
-- SECURITY: security invoker, like resolve_outbox_dispatch above and for the
-- same reason: it ALLOWS the dispatcher and backoffice to compose any row's
-- preview, and PROTECTS AGAINST other signed-in users reading composed
-- messages — their read of notification_outbox finds no row.
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

  v_body := public.substitute_template_placeholders(
    v_template.content,
    v_company.name,
    public.compose_order_details_text(v_row.payload),
    coalesce(v_row.payload ->> 'tradeDate', ''),
    v_row.payload ->> 'companyName',
    v_row.payload ->> 'productName',
    v_row.payload ->> 'productOverbooking'
  );
  if v_template.link is not null then
    v_body := v_body || chr(10) || v_template.link;
  end if;

  return v_body;
end;
$$;

comment on function public.resolve_outbox_preview(uuid) is
  'Dev-only preview: composes one notification_outbox row''s message once, addressed to the recipient company by name, with all seven template values (as resolve_outbox_dispatch), for whatsapp-dispatch''s dev environment to send to notification_settings.whatsapp_dev_override_phone. Raises P0002 if the outbox row or its template_key does not resolve.';

-- 2. build_arrangement_alerts: the 0076 body, plus "never twice". Each
-- insert skips a user who already has that alert type for that day, and the
-- day's row is locked first, so two overlapping calls cannot both decide
-- "not there yet". Inside close_arrangement the lock is already held — taking
-- it again in the same transaction is a no-op.
create or replace function public.build_arrangement_alerts(p_trading_day_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_count integer;
  v_grower_count integer;
  v_customer_alert_type_id constant uuid := '00000000-0000-0000-0000-000000000001';
  v_grower_alert_type_id constant uuid := '00000000-0000-0000-0000-000000000002';
begin
  -- SECURITY (0076): ALLOWS only a signed-in backoffice account.
  -- PROTECTS AGAINST every other caller — including a signed-in account with
  -- no profile and a caller who is not signed in at all. Both have a NULL
  -- role, and the old `<>` comparison is never true for NULL, so it let them
  -- through; `is distinct from` counts NULL as "not backoffice" and refuses.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  perform 1 from public.trading_days where id = p_trading_day_id for update;

  insert into public.alerts (
    intended_for_user_id, alert_type_id, display_record_id,
    number_for_display, send_as_whatsapp, send_as_notification
  )
  select
    p.user_id, v_customer_alert_type_id, p_trading_day_id,
    totals.pallets, at.send_as_whatsapp_default, at.send_as_notification_default
  from (
    select ar.customer_company_id, sum(ar.quantity_pallets) as pallets
    from public.arrangement_records ar
    join public.daily_order_products dop on dop.id = ar.daily_order_product_id
    join public.daily_orders do2 on do2.id = dop.daily_order_id
    where do2.trading_day_id = p_trading_day_id
      and ar.quantity_pallets > 0
      and do2.status <> 'open'
    group by ar.customer_company_id
  ) totals
  join public.profiles p on p.company_id = totals.customer_company_id
  cross join public.alert_types at
  where at.id = v_customer_alert_type_id
    and not exists (
      select 1 from public.alerts a
      where a.intended_for_user_id = p.user_id
        and a.alert_type_id = v_customer_alert_type_id
        and a.display_record_id = p_trading_day_id
    );
  get diagnostics v_customer_count = row_count;

  insert into public.alerts (
    intended_for_user_id, alert_type_id, display_record_id,
    number_for_display, send_as_whatsapp, send_as_notification
  )
  select
    p.user_id, v_grower_alert_type_id, p_trading_day_id,
    totals.pallets, at.send_as_whatsapp_default, at.send_as_notification_default
  from (
    select dp.grower_company_id, sum(ar.quantity_pallets) as pallets
    from public.arrangement_records ar
    join public.daily_pick_products dpp on dpp.id = ar.daily_pick_product_id
    join public.daily_picks dp on dp.id = dpp.daily_pick_id
    where dp.trading_day_id = p_trading_day_id
      and ar.quantity_pallets > 0
    group by dp.grower_company_id
  ) totals
  join public.profiles p on p.company_id = totals.grower_company_id
  cross join public.alert_types at
  where at.id = v_grower_alert_type_id
    and not exists (
      select 1 from public.alerts a
      where a.intended_for_user_id = p.user_id
        and a.alert_type_id = v_grower_alert_type_id
        and a.display_record_id = p_trading_day_id
    );
  get diagnostics v_grower_count = row_count;

  return v_customer_count + v_grower_count;
end;
$$;

comment on function public.build_arrangement_alerts(uuid) is
  'Backoffice-only. Writes the closing-day bell alerts for one trading day: one per user of each customer company with arranged pallets on a sent order (type ...0001) and of each grower company with arranged pallets (type ...0002), number_for_display = that company''s pallets. Idempotent: a user who already has that day''s alert of that type is skipped, under the day''s row lock. Called by close_arrangement in its own transaction. Returns how many alerts it wrote.';

-- 2. close_arrangement: the 0044 body (0065 only rewrote its description),
-- with the bell alerts back as the last write before the session log.
create or replace function public.close_arrangement()
returns public.lifecycle_sessions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_day public.trading_days;
  v_session public.lifecycle_sessions;
  v_draft_picks jsonb;
begin
  -- SECURITY: ALLOWS only a signed-in backoffice account to close the day.
  -- PROTECTS AGAINST every other caller, including a signed-in account with
  -- no profile and a caller who is not signed in: both have a NULL role,
  -- which `is distinct from` refuses (an `<>` comparison with NULL is never
  -- true, so it would let them past this line — 0076 explains). This
  -- function is security invoker, so row-level security also stops them;
  -- the check fails closed on its own as well.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  select * into v_day from public.trading_days where phase <> 'closed' for update;
  if not found then
    raise exception 'NOT_FOUND: no trading day is open' using errcode = 'P0002';
  end if;
  if v_day.phase <> 'shop_closed' then
    raise exception 'INVALID_STATE: cannot close arrangement — trading day is in phase %, expected shop_closed', v_day.phase
      using errcode = 'P0007';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'dailyPickId', dp.id,
           'growerCompanyId', dp.grower_company_id,
           'growerCompanyName', c.name,
           'status', dp.status
         )), '[]'::jsonb)
    into v_draft_picks
  from public.daily_picks dp
  join public.companies c on c.id = dp.grower_company_id
  where dp.trading_day_id = v_day.id
    and dp.status = 'draft';

  update public.daily_picks dp
  set status = 'closed',
      pickup_time = coalesce(dp.pickup_time, c.default_pickup_time),
      submitted_at = coalesce(dp.submitted_at, now()),
      updated_at = now()
  from public.companies c
  where dp.trading_day_id = v_day.id
    and c.id = dp.grower_company_id;

  -- R6: one direct call, same transaction — see 0015's header.
  perform public.close_out_pick_leftovers(v_day.id);

  -- R4: price population is part of this same transaction, not a
  -- separately triggered step that can desync from the status change.
  perform public.populate_arrangement_prices(v_day.id);

  update public.daily_arrangements
  set status = 'closed', closed_at = now()
  where trading_day_id = v_day.id;

  update public.product_varieties set highlight_price_fluctuations = false
  where highlight_price_fluctuations = true;

  update public.trading_days set phase = 'closed', updated_at = now() where id = v_day.id;

  -- R4's external-system carve-out: this writes a durable outbox row,
  -- never an outbound HTTP call, so it's safe inside this transaction —
  -- see build_notification_outbox's own comment.
  perform public.build_notification_outbox(v_day.id);

  -- The bell alerts (0024; lost in 0043, restored in 0077) — plain inserts,
  -- no network call, so they belong in this transaction too: a close that
  -- fails at any step leaves no alert behind, and one that succeeds leaves
  -- exactly one per person.
  perform public.build_arrangement_alerts(v_day.id);

  insert into public.lifecycle_sessions (trading_day_id, session_type, performed_by, metadata)
  values (v_day.id, 'end_the_day', (select auth.uid()), jsonb_build_object('draftPicksForceClosed', v_draft_picks))
  returning * into v_session;

  return v_session;
end;
$$;

comment on function public.close_arrangement() is
  'Backoffice-only. Phase 4 (terminal), one transaction: mass-closes every Daily Pick (backfilling pickup_time and submitted_at for any pick that never went through submit_pick — see migrations 0043/0044), computes end-of-day leftovers, populates arrangement prices (a record whose product has no price or price range is closed with its price left empty — migration 0065), closes the arrangement, clears price-fluctuation highlights, closes the trading day, writes the notification outbox, writes the bell alerts (build_arrangement_alerts — restored in 0077), and logs an end_the_day session — all in the same function call, so a failure at any step rolls back every step before it. Raises P0007 if the day is not in phase "shop_closed".';
