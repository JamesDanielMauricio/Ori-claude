-- Workbook Task 30 (item 2), step 1 of 2 — the per-customer pallet cap is
-- removed.
--
-- The Products screen let staff set a separate maximum for one customer
-- (product_customer_caps), but nothing ever read it: the order screen's limit
-- is the product-wide number_of_orders_per_customer and the stock
-- (max_orderable_for_customer, 0042). James (2026-11-09): remove the field.
--
-- save_product stops writing it. Its last argument, p_customer_pallet_caps,
-- is kept — optional and ignored — so the Products screen deployed today,
-- which still sends it, keeps saving products until the new web app (which
-- no longer has the field) is live. The table itself is dropped in step 2
-- (0091), AFTER that web app is live: the screens deployed today still read
-- it, and would stop loading if it went now.
--
-- The body is 0042's, apart from the removed cap block and the role check,
-- which now uses `is distinct from` (a caller with no profile has a NULL role,
-- and `<>` with NULL is not true — row-level security stopped such a caller
-- anyway, since this function runs with the caller's rights; this makes the
-- function refuse them itself, as the 2026-11-07 review asked of every
-- privileged function).
--
-- Safe to run again.

create or replace function public.save_product(
  p_id uuid,
  p_family_id uuid,
  p_name text,
  p_sizes text,
  p_pack_type public.pack_type,
  p_price numeric,
  p_price_range_from numeric,
  p_price_range_to numeric,
  p_price_type text,
  p_no_overbooking numeric,
  p_highlight_price_fluctuations boolean,
  p_is_seasonal_available boolean,
  p_number_of_orders_per_customer integer,
  p_expected_version integer,
  p_customer_pallet_caps jsonb default null
)
returns public.product_varieties
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_product public.product_varieties;
begin
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  if p_id is null then
    insert into public.product_varieties (
      family_id, name, sizes, pack_type, price, price_range_from, price_range_to,
      price_type, no_overbooking, highlight_price_fluctuations, is_seasonal_available,
      number_of_orders_per_customer, version
    )
    values (
      p_family_id, p_name, p_sizes, p_pack_type, p_price, p_price_range_from, p_price_range_to,
      p_price_type, p_no_overbooking, p_highlight_price_fluctuations, p_is_seasonal_available,
      p_number_of_orders_per_customer, 1
    )
    returning * into v_product;
  else
    update public.product_varieties
    set family_id = p_family_id,
        name = p_name,
        sizes = p_sizes,
        pack_type = p_pack_type,
        price = p_price,
        price_range_from = p_price_range_from,
        price_range_to = p_price_range_to,
        price_type = p_price_type,
        no_overbooking = p_no_overbooking,
        highlight_price_fluctuations = p_highlight_price_fluctuations,
        is_seasonal_available = p_is_seasonal_available,
        number_of_orders_per_customer = p_number_of_orders_per_customer,
        version = version + 1,
        updated_at = now()
    where id = p_id and version = p_expected_version
    returning * into v_product;

    if not found then
      if exists (select 1 from public.product_varieties where id = p_id) then
        raise exception
          'CONFLICT: product % was modified by someone else since it was loaded (expected version %)',
          p_id, p_expected_version
          using errcode = 'P0003';
      else
        raise exception 'NOT_FOUND: product % does not exist', p_id using errcode = 'P0002';
      end if;
    end if;
  end if;

  return v_product;
end;
$$;

comment on function public.save_product(
  uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric,
  boolean, boolean, integer, integer, jsonb
) is
  'Backoffice-only. Upserts a product variety with optimistic concurrency (p_expected_version must match the current row; raises P0003 on conflict). Pass p_id = null to create (version starts at 1, p_expected_version ignored). p_number_of_orders_per_customer is the variety-level order cap (migration 0042; null = uncapped). p_customer_pallet_caps is ignored: the per-customer cap was removed (migration 0087) and the argument is kept only so a client that still sends it keeps working.';

-- SECURITY: ALLOWS signed-in users to call it — the function then refuses
-- everyone but backoffice, and being SECURITY INVOKER it writes through the
-- caller's own row-level security (product_varieties_write_backoffice).
-- PROTECTS AGAINST anonymous callers reaching it at all.
revoke execute on function public.save_product(
  uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric,
  boolean, boolean, integer, integer, jsonb
) from public, anon;
grant execute on function public.save_product(
  uuid, uuid, text, text, public.pack_type, numeric, numeric, numeric, text, numeric,
  boolean, boolean, integer, integer, jsonb
) to authenticated;
