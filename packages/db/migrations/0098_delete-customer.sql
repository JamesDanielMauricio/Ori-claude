-- delete_customer: a customer that never ordered can be deleted, even while a
-- shop is open (James, 2026-11-12).
--
-- A customer added, or made active again, while a day's shop is open gets
-- that day's order header straight away, so it can order (save_customer,
-- 0080), and one shop-open message is queued for it. That is right, and it
-- stays: the header carries no order lines until the customer orders. But
-- the header and the message both name the company, and neither foreign key
-- cascades, so the Customers screen refused to delete a customer that had
-- never ordered anything ("הרשומה כבר בשימוש"). Found on the live app on
-- 2026-11-12. Every customer active when a shop opens gets the same empty
-- header (open_shop, 0031), so a long-standing customer that never ordered
-- could not be deleted either.
--
-- What now goes with the customer:
--   - its orders that were never placed: no order line and never sent (no
--     order_submission_logs row). Those are the empty headers above;
--   - the messages addressed to it in notification_outbox.
-- Anything else that still names the customer (an order with a line, an
-- arrangement, a user) makes the final delete fail with 23503. The whole call
-- then rolls back, the deletes above included, and the screen says what it
-- always said: in use, make it inactive instead. Real history is never
-- deleted, only the leftovers of a customer that never traded.
--
-- An RPC, like save_customer, rather than the screen's plain delete: one
-- call site for the backoffice check, and the three deletes in one
-- transaction. security invoker: backoffice already writes all three tables
-- under its own row-level security (daily_orders_write_backoffice,
-- notification_outbox_backoffice, and the companies policies the screen's
-- delete used).
--
-- Safe to run again.

create or replace function public.delete_customer(p_customer_company_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- `is distinct from`, not `<>`: a caller with no profile has a NULL role,
  -- and NULL <> 'backoffice' is not true. Row-level security would still
  -- refuse the deletes below; this refuses the call by name first.
  if public.current_role() is distinct from 'backoffice' then
    raise exception 'FORBIDDEN: backoffice role required' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.companies
    where id = p_customer_company_id and type = 'customer'
  ) then
    raise exception 'NOT_FOUND: customer company % does not exist', p_customer_company_id using errcode = 'P0002';
  end if;

  -- Orders never placed: no line, never sent.
  delete from public.daily_orders o
  where o.customer_company_id = p_customer_company_id
    and not exists (select 1 from public.daily_order_products l where l.daily_order_id = o.id)
    and not exists (select 1 from public.order_submission_logs s where s.daily_order_id = o.id);

  delete from public.notification_outbox
  where recipient_company_id = p_customer_company_id;

  -- Fails with 23503 if anything else still names the customer, and the
  -- whole call rolls back with it.
  delete from public.companies where id = p_customer_company_id;
end;
$$;

comment on function public.delete_customer(uuid) is
  'Backoffice-only. Deletes a customer company together with its orders that were never placed (no order line, never sent) and the messages addressed to it. A customer with anything else (an order with a line, an arrangement, a user) is refused with 23503 and nothing is deleted. Raises 42501 for a non-backoffice caller, P0002 if the company does not exist or is not a customer.';

-- SECURITY: ALLOWS signed-in users (`authenticated`) and the service role to
-- call it; the function then refuses everyone but backoffice, and being
-- SECURITY INVOKER it deletes through the caller's own row-level security.
-- PROTECTS AGAINST anonymous callers reaching it at all: Postgres grants
-- EXECUTE on every new function to PUBLIC, and Supabase's default privileges
-- add `anon`, so both are revoked here (as for set_customer_score, 0074).
revoke execute on function public.delete_customer(uuid) from public, anon;
grant execute on function public.delete_customer(uuid) to authenticated, service_role;
