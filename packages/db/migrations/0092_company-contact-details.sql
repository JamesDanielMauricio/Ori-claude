-- Bubble column parity, part 1 (docs/superpowers/specs/2026-11-10-bubble-column-parity-design.md §4).
--
-- Bubble's Growers, Customers and Transporters screens show each company's
-- טלפון, כתובת, יישוב and הנה״ח (ח.פ. + מספר בהנה״ח); Ori had no columns for
-- them. This adds five optional text columns to companies and teaches the
-- three company save functions to write them.
--
-- The rule for the new inputs (the same as 0082's p_no_arrangement_message):
-- an input that is not sent keeps what is stored; empty text clears it
-- (stored as NULL); any other text is saved trimmed. So a browser tab still
-- running the previous web app — which does not know these inputs — cannot
-- wipe them when it saves a company.
--
-- Run it before the web app from the same release goes live. Copies of the
-- app from before it keep working: they leave the new inputs out.
--
-- Each function keeps its latest body (save_grower 0082, save_customer 0080,
-- save_transporter 0057) apart from the new inputs, and — for
-- save_transporter — the role check, which now fails closed the way 0080 and
-- 0082 made it for the other two (see its comment).
--
-- Safe to run again.

-- 1. The columns. Free text for people to read: nothing sends messages to
-- these phones, and Bubble's values come in mixed formats.
alter table public.companies
  add column if not exists phone text,
  add column if not exists address_line text,
  add column if not exists city text,
  add column if not exists tax_id text,
  add column if not exists accounting_id text;

comment on column public.companies.phone is
  'טלפון — the company''s phone (Bubble "Phone no."). Free text; NULL when unset. Migration 0092.';
comment on column public.companies.address_line is
  'כתובת — the company''s street address (Bubble "Address Line"). NULL when unset. Migration 0092.';
comment on column public.companies.city is
  'יישוב — the company''s city or village (Bubble "City"). NULL when unset. Migration 0092.';
comment on column public.companies.tax_id is
  'ח.פ. — the company''s tax ID (Bubble "Tax ID"), shown under הנה״ח. NULL when unset. Migration 0092.';
comment on column public.companies.accounting_id is
  'מספר בהנה״ח — the company''s number in the accounting system (Bubble "Accounting ID"), shown under הנה״ח. NULL when unset. Migration 0092.';

-- ---------------------------------------------------------------------------
-- 2. save_grower — 0082's body plus the five inputs.
-- ---------------------------------------------------------------------------
-- An added parameter makes a NEW function in Postgres rather than replacing
-- the old one, so the old signature is dropped: PostgREST then has exactly
-- one save_grower to call.
drop function if exists public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean);

create or replace function public.save_grower(
  p_id uuid,
  p_name text,
  p_status public.company_status,
  p_default_pickup_time time,
  p_whatsapp_group_id text,
  p_product_variety_ids uuid[],
  p_transporter_company_id uuid default null,
  p_contact_person_id uuid default null,
  p_no_arrangement_message boolean default null,
  p_phone text default null,
  p_address_line text default null,
  p_city text default null,
  p_tax_id text default null,
  p_accounting_id text default null
)
returns public.companies
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company public.companies;
  v_transporter_type public.company_type;
begin
  -- SECURITY: ALLOWS only backoffice staff to add or change a grower.
  -- PROTECTS AGAINST customers, growers, a signed-in account with no profile
  -- and a signed-out caller. Until 0082 this used `<>`, which is never true
  -- when the role is NULL, so for those two only the table's security
  -- policies stopped the write; `is distinct from` refuses them up front.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  if p_transporter_company_id is not null then
    select type into v_transporter_type from public.companies where id = p_transporter_company_id;
    if not found or v_transporter_type <> 'transporter' then
      raise exception 'INVALID_INPUT: % is not a transporter company', p_transporter_company_id using errcode = 'P0008';
    end if;
  end if;

  if p_id is null then
    insert into public.companies (
      name, type, status, default_pickup_time, whatsapp_group_id, transporter_company_id, contact_person_id, no_arrangement_message,
      phone, address_line, city, tax_id, accounting_id
    )
    values (
      p_name, 'grower', p_status, p_default_pickup_time, p_whatsapp_group_id, p_transporter_company_id, p_contact_person_id,
      coalesce(p_no_arrangement_message, false),
      nullif(btrim(p_phone), ''), nullif(btrim(p_address_line), ''), nullif(btrim(p_city), ''),
      nullif(btrim(p_tax_id), ''), nullif(btrim(p_accounting_id), '')
    )
    returning * into v_company;
  else
    update public.companies
    set name = p_name,
        status = p_status,
        default_pickup_time = p_default_pickup_time,
        whatsapp_group_id = p_whatsapp_group_id,
        transporter_company_id = p_transporter_company_id,
        contact_person_id = p_contact_person_id,
        no_arrangement_message = coalesce(p_no_arrangement_message, no_arrangement_message),
        -- 0092: not sent keeps the stored value; empty text clears it.
        phone = case when p_phone is null then phone else nullif(btrim(p_phone), '') end,
        address_line = case when p_address_line is null then address_line else nullif(btrim(p_address_line), '') end,
        city = case when p_city is null then city else nullif(btrim(p_city), '') end,
        tax_id = case when p_tax_id is null then tax_id else nullif(btrim(p_tax_id), '') end,
        accounting_id = case when p_accounting_id is null then accounting_id else nullif(btrim(p_accounting_id), '') end,
        updated_at = now()
    where id = p_id and type = 'grower'
    returning * into v_company;

    if not found then
      raise exception 'NOT_FOUND: grower company % does not exist', p_id using errcode = 'P0002';
    end if;
  end if;

  delete from public.grower_products
  where company_id = v_company.id
    and not (product_variety_id = any(coalesce(p_product_variety_ids, array[]::uuid[])));

  insert into public.grower_products (company_id, product_variety_id)
  select v_company.id, pv_id
  from unnest(coalesce(p_product_variety_ids, array[]::uuid[])) as pv_id
  on conflict (company_id, product_variety_id) do nothing;

  perform public.sync_grower_picks(v_company.id);

  return v_company;
end;
$$;

comment on function public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean, text, text, text, text, text) is
  'Backoffice-only. Adds a grower company (p_id null) or updates one, replaces its in-season products and syncs today''s pick (0037). p_no_arrangement_message (0082) sets Bubble''s "Should not receive arrangement?"; null keeps the current setting (false for a new grower). p_phone, p_address_line, p_city, p_tax_id, p_accounting_id (0092): null keeps the stored value, empty text clears it, other text is saved trimmed.';

-- SECURITY: ALLOWS signed-in users and the service role to call save_grower;
-- inside, only the back office passes the current_role() check above.
-- PROTECTS AGAINST anonymous visitors calling it at all. Dropping a function
-- drops its permissions, and a new function is executable by PUBLIC (and, on
-- Supabase, by anon) until revoked — so this restates what 0082 set.
revoke execute on function public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean, text, text, text, text, text) from public, anon;
grant execute on function public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean, text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. save_customer — 0080's body plus the five inputs.
-- ---------------------------------------------------------------------------
drop function if exists public.save_customer(uuid, text, public.company_status, boolean, text, uuid);

create or replace function public.save_customer(
  p_id uuid,
  p_name text,
  p_status public.company_status,
  p_can_see_product_prices boolean,
  p_whatsapp_group_id text,
  p_contact_person_id uuid default null,
  p_phone text default null,
  p_address_line text default null,
  p_city text default null,
  p_tax_id text default null,
  p_accounting_id text default null
)
returns public.companies
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company public.companies;
  v_day_id uuid;
  v_phase public.trading_day_phase;
  v_trade_date date;
begin
  -- SECURITY: ALLOWS only backoffice staff to add or change a customer.
  -- PROTECTS AGAINST customers, growers, a signed-in account with no profile
  -- and a signed-out caller. Until 0080 this used `<>`, which is never true
  -- when the role is NULL (no profile / not signed in), so for them the check
  -- passed silently and only the table's security policies stopped the
  -- write. `is distinct from` counts NULL as a mismatch and refuses up front.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  if p_id is null then
    insert into public.companies (
      name, type, status, can_see_product_prices, whatsapp_group_id, contact_person_id,
      phone, address_line, city, tax_id, accounting_id
    )
    values (
      p_name, 'customer', p_status, p_can_see_product_prices, p_whatsapp_group_id, p_contact_person_id,
      nullif(btrim(p_phone), ''), nullif(btrim(p_address_line), ''), nullif(btrim(p_city), ''),
      nullif(btrim(p_tax_id), ''), nullif(btrim(p_accounting_id), '')
    )
    returning * into v_company;
  else
    update public.companies
    set name = p_name,
        status = p_status,
        can_see_product_prices = p_can_see_product_prices,
        whatsapp_group_id = p_whatsapp_group_id,
        contact_person_id = p_contact_person_id,
        -- 0092: not sent keeps the stored value; empty text clears it.
        phone = case when p_phone is null then phone else nullif(btrim(p_phone), '') end,
        address_line = case when p_address_line is null then address_line else nullif(btrim(p_address_line), '') end,
        city = case when p_city is null then city else nullif(btrim(p_city), '') end,
        tax_id = case when p_tax_id is null then tax_id else nullif(btrim(p_tax_id), '') end,
        accounting_id = case when p_accounting_id is null then accounting_id else nullif(btrim(p_accounting_id), '') end,
        updated_at = now()
    where id = p_id and type = 'customer'
    returning * into v_company;

    if not found then
      raise exception 'NOT_FOUND: customer company % does not exist', p_id using errcode = 'P0002';
    end if;
  end if;

  -- 0080: an active customer joins a day whose shop has already opened.
  if v_company.status = 'active' then
    -- The one day that is not closed, locked `for share` the way
    -- submit_order reads it: if open_shop is running at this moment (it
    -- locks this row `for update` first), this waits for it to finish and
    -- then sees the new phase — so a customer saved while the shop opens is
    -- covered either by open_shop or by this, never by neither.
    select id, phase, trade_date into v_day_id, v_phase, v_trade_date
    from public.trading_days
    where phase <> 'closed'
    for share;

    if found and v_phase in ('shop_open', 'shop_closed') then
      insert into public.daily_orders (trading_day_id, customer_company_id)
      values (v_day_id, v_company.id)
      on conflict (trading_day_id, customer_company_id) do nothing;

      -- Only when the header is new: the customer was not in the shop yet.
      if found and v_phase = 'shop_open' then
        insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload)
        values (v_day_id, 'customer', v_company.id, 'shop_open', jsonb_build_object('tradeDate', v_trade_date, 'lines', '[]'::jsonb));
      end if;
    end if;
  end if;

  return v_company;
end;
$$;

comment on function public.save_customer(uuid, text, public.company_status, boolean, text, uuid, text, text, text, text, text) is
  'Backoffice-only. Adds a customer company (p_id null) or updates one. Since 0080: an active customer saved after the day''s shop opened gets that day''s order header (so they can order, and staff can order for them), plus one shop_open message while the shop is still open — only if they did not have the header yet. p_phone, p_address_line, p_city, p_tax_id, p_accounting_id (0092): null keeps the stored value, empty text clears it, other text is saved trimmed.';

-- SECURITY: ALLOWS signed-in users and the service role to call
-- save_customer; inside, only the back office passes the current_role()
-- check above. PROTECTS AGAINST anonymous visitors calling it at all: live
-- granted EXECUTE to anon and PUBLIC on save_customer and save_transporter
-- until now (refused inside, but reachable). 0082 closed the same gap on
-- save_grower.
revoke execute on function public.save_customer(uuid, text, public.company_status, boolean, text, uuid, text, text, text, text, text) from public, anon;
grant execute on function public.save_customer(uuid, text, public.company_status, boolean, text, uuid, text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. save_transporter — 0057's body plus the five inputs, and a role check
-- that fails closed.
-- ---------------------------------------------------------------------------
drop function if exists public.save_transporter(uuid, text, public.company_status, text, uuid);

create or replace function public.save_transporter(
  p_id uuid,
  p_name text,
  p_status public.company_status,
  p_whatsapp_group_id text,
  p_contact_person_id uuid default null,
  p_phone text default null,
  p_address_line text default null,
  p_city text default null,
  p_tax_id text default null,
  p_accounting_id text default null
)
returns public.companies
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_company public.companies;
begin
  -- SECURITY: ALLOWS only backoffice staff to add or change a transporter.
  -- PROTECTS AGAINST customers, growers, a signed-in account with no profile
  -- and a signed-out caller. Until 0092 this used `<>`, which is never true
  -- when the role is NULL, so for those two only the table's security
  -- policies stopped the write; `is distinct from` refuses them up front
  -- (the change 0080 and 0082 made to save_customer and save_grower).
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  if p_id is null then
    insert into public.companies (
      name, type, status, whatsapp_group_id, contact_person_id,
      phone, address_line, city, tax_id, accounting_id
    )
    values (
      p_name, 'transporter', p_status, p_whatsapp_group_id, p_contact_person_id,
      nullif(btrim(p_phone), ''), nullif(btrim(p_address_line), ''), nullif(btrim(p_city), ''),
      nullif(btrim(p_tax_id), ''), nullif(btrim(p_accounting_id), '')
    )
    returning * into v_company;
  else
    update public.companies
    set name = p_name,
        status = p_status,
        whatsapp_group_id = p_whatsapp_group_id,
        contact_person_id = p_contact_person_id,
        -- 0092: not sent keeps the stored value; empty text clears it.
        phone = case when p_phone is null then phone else nullif(btrim(p_phone), '') end,
        address_line = case when p_address_line is null then address_line else nullif(btrim(p_address_line), '') end,
        city = case when p_city is null then city else nullif(btrim(p_city), '') end,
        tax_id = case when p_tax_id is null then tax_id else nullif(btrim(p_tax_id), '') end,
        accounting_id = case when p_accounting_id is null then accounting_id else nullif(btrim(p_accounting_id), '') end,
        updated_at = now()
    where id = p_id and type = 'transporter'
    returning * into v_company;

    if not found then
      raise exception 'NOT_FOUND: transporter company % does not exist', p_id using errcode = 'P0002';
    end if;
  end if;

  return v_company;
end;
$$;

comment on function public.save_transporter(uuid, text, public.company_status, text, uuid, text, text, text, text, text) is
  'Backoffice-only. Upserts a transporter company row, including its contact_person_id. Pass p_id = null to create. p_phone, p_address_line, p_city, p_tax_id, p_accounting_id (0092): null keeps the stored value, empty text clears it, other text is saved trimmed.';

-- SECURITY: ALLOWS signed-in users and the service role to call
-- save_transporter; inside, only the back office passes the current_role()
-- check above. PROTECTS AGAINST anonymous visitors calling it at all (live
-- granted anon and PUBLIC until now — refused inside, but reachable).
revoke execute on function public.save_transporter(uuid, text, public.company_status, text, uuid, text, text, text, text, text) from public, anon;
grant execute on function public.save_transporter(uuid, text, public.company_status, text, uuid, text, text, text, text, text) to authenticated, service_role;
