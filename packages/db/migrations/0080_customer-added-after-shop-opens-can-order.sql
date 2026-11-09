-- Workbook Task 24 (review issue 8): a customer added — or made active
-- again — after the shop opened could not order that day. Every order hangs
-- off a daily_orders header, and only open_shop (0031) creates those, for the
-- customers that were active at that moment. submit_order then refused the
-- new customer ("no daily order exists"), and staff could not order on their
-- behalf either. In Bubble, "Update the business day" creates the missing data
-- and sends the customer the shop-is-open message (Main alert 4).
--
-- Now save_customer — what the Customers screen calls to add a customer or
-- change one's status — does the same, in the same transaction: when the
-- saved customer is active and today's shop has already opened (shop_open or
-- shop_closed), it adds that customer's order header for the day, and while
-- the shop is still open it queues one shop_open message for them (sent right
-- away, 0079). A customer who already has the header — anyone active when the
-- shop opened, or saved before — gets nothing new, so the message never
-- repeats. Before the shop opens nothing changes: open_shop still does it.
--
-- Everything else in save_customer is 0057's body unchanged, except the role
-- check (see its comment). No table changes. Safe to run again.

create or replace function public.save_customer(
  p_id uuid,
  p_name text,
  p_status public.company_status,
  p_can_see_product_prices boolean,
  p_whatsapp_group_id text,
  p_contact_person_id uuid default null
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
    insert into public.companies (name, type, status, can_see_product_prices, whatsapp_group_id, contact_person_id)
    values (p_name, 'customer', p_status, p_can_see_product_prices, p_whatsapp_group_id, p_contact_person_id)
    returning * into v_company;
  else
    update public.companies
    set name = p_name,
        status = p_status,
        can_see_product_prices = p_can_see_product_prices,
        whatsapp_group_id = p_whatsapp_group_id,
        contact_person_id = p_contact_person_id,
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

comment on function public.save_customer(uuid, text, public.company_status, boolean, text, uuid) is
  'Backoffice-only. Adds a customer company (p_id null) or updates one. Since 0080: an active customer saved after the day''s shop opened gets that day''s order header (so they can order, and staff can order for them), plus one shop_open message while the shop is still open — only if they did not have the header yet.';
