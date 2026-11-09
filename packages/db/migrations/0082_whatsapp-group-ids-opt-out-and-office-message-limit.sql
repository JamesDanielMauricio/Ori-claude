-- Workbook Task 29 — keep other companies and floods out of WhatsApp. (The
-- token in stored errors was Task 29's first step; 0078 already strips it.)
--
-- 1. A WhatsApp group id belongs to one company. Two companies with the same
--    group id meant one company's sales went into the other's chat. Saving a
--    company with a group id another company already has is now refused,
--    with the other company's name. Group ids that are already shared stay
--    as they are until someone changes one of them; to list them:
--      select whatsapp_group_id, string_agg(name, ', ') from companies
--      where btrim(coalesce(whatsapp_group_id, '')) <> ''
--      group by whatsapp_group_id having count(*) > 1;
-- 2. The Growers screen can set Bubble's "Should not receive arrangement?"
--    (companies.no_arrangement_message, 0081): save_grower takes it as an
--    optional last argument. Left out — as the "בשם מגדל" products dialog
--    does — it keeps the grower's current setting.
-- 3. Office messages that customers and growers trigger (an order sent, a
--    pick updated, a stock alert) are capped: at most 5 of the same kind
--    about the same company or product within 10 minutes. Without it, a
--    customer saving over and over — or a script calling the API in a loop —
--    sent the office one WhatsApp per save, enough to get the number blocked.
--
-- Rollout: the web app's new Growers column needs this first; the web app
-- deployed today keeps working after it. Safe to run again.

-- 1. One company per WhatsApp group.
--
-- SECURITY: a check on saves made through the app. ALLOWS any company to have
-- a group id no other company uses (and every group id that is left unchanged,
-- so existing shared ids can still be saved while someone sorts them out).
-- PROTECTS AGAINST a second company being given a group that already belongs
-- to another — the dispatcher sends to whatever group a company has, so that
-- would put one company's orders and sales in front of another. Only saves by
-- a signed-in user are checked (auth.uid() is set): the Bubble importer and
-- migrations run as the database owner, so a cutover import of Bubble's data
-- as it is cannot fail on a duplicate. Security definer so the lookup sees
-- every company, whatever the caller's own row access; it reads only names.
create or replace function public.companies_whatsapp_group_id_unique()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_other text;
begin
  if new.whatsapp_group_id is null or btrim(new.whatsapp_group_id) = '' then
    return new;
  end if;
  if tg_op = 'UPDATE' and btrim(coalesce(old.whatsapp_group_id, '')) = btrim(new.whatsapp_group_id) then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;
  select c.name into v_other
  from public.companies c
  where btrim(c.whatsapp_group_id) = btrim(new.whatsapp_group_id)
    and c.id <> new.id
  limit 1;
  if found then
    raise exception 'קבוצת הוואטסאפ הזו כבר משויכת ל"%". לכל חברה צריכה להיות קבוצה משלה.', v_other
      using errcode = '23505';
  end if;
  return new;
end;
$$;

revoke execute on function public.companies_whatsapp_group_id_unique() from public, anon, authenticated, service_role;

drop trigger if exists companies_whatsapp_group_id_unique on public.companies;
create trigger companies_whatsapp_group_id_unique
  before insert or update of whatsapp_group_id on public.companies
  for each row
  execute function public.companies_whatsapp_group_id_unique();

-- 2. save_grower with the opt-out. 0057's body unchanged apart from the new
-- argument and the role check (see its comment). The old signature is
-- dropped so PostgREST has one save_grower to call; callers that leave the
-- new argument out reach this one and keep the grower's setting.
drop function if exists public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid);

create or replace function public.save_grower(
  p_id uuid,
  p_name text,
  p_status public.company_status,
  p_default_pickup_time time,
  p_whatsapp_group_id text,
  p_product_variety_ids uuid[],
  p_transporter_company_id uuid default null,
  p_contact_person_id uuid default null,
  p_no_arrangement_message boolean default null
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
      name, type, status, default_pickup_time, whatsapp_group_id, transporter_company_id, contact_person_id, no_arrangement_message
    )
    values (
      p_name, 'grower', p_status, p_default_pickup_time, p_whatsapp_group_id, p_transporter_company_id, p_contact_person_id,
      coalesce(p_no_arrangement_message, false)
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

comment on function public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean) is
  'Backoffice-only. Adds a grower company (p_id null) or updates one, replaces its in-season products and syncs today''s pick (0037). p_no_arrangement_message (0082) sets Bubble''s "Should not receive arrangement?"; null keeps the current setting (false for a new grower).';

grant execute on function public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean) to authenticated;
revoke execute on function public.save_grower(uuid, text, public.company_status, time, text, uuid[], uuid, uuid, boolean) from public, anon;

-- 3. The office-message cap. 0031's enqueue_backoffice_notification with one
-- more condition. Still security definer and still callable only by the
-- functions that use it (0055 revoked it from every API role; create or
-- replace keeps that).
create index if not exists notification_outbox_office_cap_idx
  on public.notification_outbox (recipient_company_id, template_key, created_at);

-- SECURITY: ALLOWS ordinary use — up to 5 office messages of one kind about
-- one company (or one product, for stock alerts) per 10 minutes, far more
-- than saving, fixing and saving again produces. PROTECTS AGAINST a customer
-- or grower flooding the office WhatsApp by saving over and over, or by
-- calling the API in a loop: past the cap the save still works, it just
-- sends no further message until the window moves on.
create or replace function public.enqueue_backoffice_notification(
  p_trading_day_id uuid,
  p_template_key text,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notification_outbox (trading_day_id, recipient_type, recipient_company_id, template_key, payload)
  select p_trading_day_id, 'backoffice', c.id, p_template_key, p_payload
  from public.companies c
  where c.type = 'backoffice' and c.status = 'active'
    and (
      select count(*)
      from public.notification_outbox o
      where o.recipient_company_id = c.id
        and o.template_key = p_template_key
        and o.created_at > now() - interval '10 minutes'
        and o.trading_day_id is not distinct from p_trading_day_id
        and coalesce(o.payload ->> 'companyName', '') = coalesce(p_payload ->> 'companyName', '')
        and coalesce(o.payload ->> 'productName', '') = coalesce(p_payload ->> 'productName', '')
    ) < 5;
end;
$$;
