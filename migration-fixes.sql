-- Apply after schema.sql, migration-orders-and-checkout.sql, and
-- migration-coupons.sql. This idempotent patch repairs payment retry/expiry
-- behavior and keeps released inventory and coupon reservations traceable.

alter table public.store_orders
  add column if not exists stock_released_at timestamptz,
  add column if not exists cash_collected_at timestamptz,
  add column if not exists payment_reconciled_at timestamptz,
  add column if not exists gateway_amount_paise bigint;

-- All order mutations go through the private Vercel service-role API.
revoke update on public.store_orders from public, anon, authenticated;
drop policy if exists "Lincy admin updates orders" on public.store_orders;

-- Use a server-managed Supabase app-metadata role for every admin RLS check.
-- This keeps the SQL, browser and API authorization decisions aligned.
create or replace function public.is_lincy_admin()
returns boolean
language sql stable security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from auth.users u
     where u.id = auth.uid()
       and u.email_confirmed_at is not null
       and coalesce(u.raw_app_meta_data->>'store_role', '') = 'admin'
  );
$$;
revoke all on function public.is_lincy_admin() from public, anon;
grant execute on function public.is_lincy_admin() to authenticated, service_role;
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"store_role":"admin"}'::jsonb
 where lower(email) = 'mishalmj03@gmail.com'
   and email_confirmed_at is not null
   and raw_app_meta_data->>'store_role' is distinct from 'admin';

drop policy if exists "Lincy admin manages products" on public.store_products;
create policy "Lincy admin manages products" on public.store_products for all to authenticated
  using (public.is_lincy_admin()) with check (public.is_lincy_admin());
drop policy if exists "Lincy admin reads orders" on public.store_orders;
create policy "Lincy admin reads orders" on public.store_orders for select to authenticated
  using (public.is_lincy_admin());
drop policy if exists "Lincy admin reads order items" on public.store_order_items;
create policy "Lincy admin reads order items" on public.store_order_items for select to authenticated
  using (exists (select 1 from public.store_orders o where o.id = order_id and public.is_lincy_admin()));
drop policy if exists "Lincy admin reads subscribers" on public.store_subscribers;
create policy "Lincy admin reads subscribers" on public.store_subscribers for select to authenticated
  using (public.is_lincy_admin());
drop policy if exists "Store owner uploads product images" on storage.objects;
create policy "Store owner uploads product images" on storage.objects for insert to authenticated
  with check (bucket_id = 'store-product-images' and public.is_lincy_admin());
drop policy if exists "Store owner updates product images" on storage.objects;
create policy "Store owner updates product images" on storage.objects for update to authenticated
  using (bucket_id = 'store-product-images' and public.is_lincy_admin())
  with check (bucket_id = 'store-product-images' and public.is_lincy_admin());
drop policy if exists "Store owner deletes product images" on storage.objects;
create policy "Store owner deletes product images" on storage.objects for delete to authenticated
  using (bucket_id = 'store-product-images' and public.is_lincy_admin());

-- Keep the rate-limit table bounded without making cleanup part of a shopper
-- request. The scheduled reconciliation endpoint invokes this best-effort.
create or replace function public.cleanup_store_api_rate_limits()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_deleted integer;
begin
  delete from public.store_api_rate_limits
   where updated_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.cleanup_store_api_rate_limits() from public, anon, authenticated;
grant execute on function public.cleanup_store_api_rate_limits() to service_role;

-- Earlier versions marked failed checkouts only after releasing inventory.
update public.store_orders
   set stock_released_at = coalesce(stock_released_at, updated_at, created_at)
 where payment_status = 'failed' and stock_released_at is null;

create index if not exists store_orders_payment_reconcile_idx
  on public.store_orders(payment_reconciled_at, created_at, id)
  where payment_provider = 'razorpay' and payment_status in ('pending','failed');

create or replace function public.fail_checkout_order(
  p_order_id uuid,
  p_razorpay_order_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
  v_line record;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found or v_order.payment_status <> 'pending' or v_order.stock_released_at is not null then
    return false;
  end if;
  if p_razorpay_order_id is not null
     and v_order.razorpay_order_id is distinct from p_razorpay_order_id then
    return false;
  end if;
  -- Once an online order exists, only the reconciler may expire it after the
  -- reservation window. Explicit customer cancellation uses its own RPC after
  -- the API confirms Razorpay has no live/captured payment.
  if v_order.payment_provider = 'razorpay'
     and v_order.razorpay_order_id is not null
     and v_order.created_at > now() - interval '45 minutes' then
    return false;
  end if;

  update public.store_orders
     set payment_status = 'failed', stock_released_at = now(),
         razorpay_order_creation_token = null,
         razorpay_order_creating_at = null,
         updated_at = now()
   where id = v_order.id;
  for v_line in
    select product_id, quantity from public.store_order_items
     where order_id = v_order.id and product_id is not null
  loop
    update public.store_products set stock = stock + v_line.quantity
     where id = v_line.product_id;
  end loop;
  if to_regprocedure('public.release_coupon_redemption(uuid)') is not null then
    perform public.release_coupon_redemption(v_order.id);
  end if;
  return true;
end;
$$;

create or replace function public.release_pending_checkout_after_cancel(
  p_order_id uuid,
  p_razorpay_order_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
  v_line record;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found or v_order.payment_status <> 'pending'
     or v_order.payment_provider <> 'razorpay'
     or v_order.razorpay_order_id is distinct from p_razorpay_order_id
     or v_order.stock_released_at is not null then
    return false;
  end if;
  update public.store_orders set payment_status = 'failed', stock_released_at = now(),
    razorpay_order_creation_token = null, razorpay_order_creating_at = null,
    updated_at = now() where id = v_order.id;
  for v_line in
    select product_id, quantity from public.store_order_items
     where order_id = v_order.id and product_id is not null
  loop
    update public.store_products set stock = stock + v_line.quantity
     where id = v_line.product_id;
  end loop;
  if to_regprocedure('public.release_coupon_redemption(uuid)') is not null then
    perform public.release_coupon_redemption(v_order.id);
  end if;
  return true;
end;
$$;

-- A payment can fail once and still be retried in Razorpay. If a capture arrives
-- after the 45-minute hold expired, try to reserve the exact stock again under
-- product-row locks. Only ask the store to refund when the order was cancelled
-- or the stock cannot be recovered.
create or replace function public.record_razorpay_capture(
  p_gateway_order_id text,
  p_payment_id text,
  p_amount_paise bigint,
  p_currency text,
  p_allow_customer_fee boolean,
  p_max_customer_fee_bps integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.store_orders%rowtype;
  v_line record;
  v_product public.store_products%rowtype;
  v_duplicate boolean := false;
  v_late boolean := false;
  v_recover boolean := false;
  v_can_recover boolean := true;
  v_reason text;
  v_note text;
  v_expected_paise bigint;
begin
  if p_gateway_order_id is null or length(p_gateway_order_id) > 100
    or p_payment_id is null or p_payment_id !~ '^pay_[A-Za-z0-9]+$'
    or p_currency <> 'INR' or p_amount_paise < 1 then
    return jsonb_build_object('ignored', true);
  end if;

  select * into v_order from public.store_orders
   where razorpay_order_id = p_gateway_order_id for update;
  if not found then
    return jsonb_build_object('ignored', true);
  end if;
  v_expected_paise := v_order.total::bigint * 100;
  if p_amount_paise <> v_expected_paise and not (
    p_allow_customer_fee is true
    and p_max_customer_fee_bps between 1 and 5000
    and p_amount_paise > v_expected_paise
    and p_amount_paise <= v_expected_paise + ceil(v_expected_paise::numeric * p_max_customer_fee_bps / 10000)::bigint
  ) then
    return jsonb_build_object('ignored', true);
  end if;
  if v_order.refund_payment_reference = p_payment_id then
    return jsonb_build_object('duplicate', true, 'refundReview', true,
      'latePayment', v_order.status = 'cancelled', 'duplicatePayment', v_order.status <> 'cancelled',
      'orderId', v_order.id, 'orderNumber', v_order.order_number);
  end if;
  if v_order.payment_status in ('paid','refunded') and v_order.payment_reference = p_payment_id then
    return jsonb_build_object('duplicate', true, 'refundReview', false,
      'latePayment', false, 'duplicatePayment', false,
      'orderId', v_order.id, 'orderNumber', v_order.order_number);
  end if;

  v_duplicate := v_order.payment_status in ('paid','refunded');
  v_recover := v_order.payment_status = 'failed' and v_order.status <> 'cancelled';
  if v_recover and v_order.stock_released_at is not null then
    -- Stable ordering prevents two late captures from deadlocking while they
    -- try to reclaim stock from the same set of products.
    for v_line in
      select product_id, sum(quantity)::integer as quantity
        from public.store_order_items
       where order_id = v_order.id and product_id is not null
       group by product_id order by product_id
    loop
      select * into v_product from public.store_products where id = v_line.product_id for update;
      if not found or v_product.active is distinct from true or v_product.stock < v_line.quantity then
        v_can_recover := false;
      end if;
    end loop;
    if v_can_recover then
      for v_line in
        select product_id, sum(quantity)::integer as quantity
          from public.store_order_items
         where order_id = v_order.id and product_id is not null
         group by product_id order by product_id
      loop
        update public.store_products set stock = stock - v_line.quantity
         where id = v_line.product_id;
      end loop;
      update public.store_orders set stock_released_at = null where id = v_order.id;
    end if;
  end if;

  v_late := (v_order.status = 'cancelled')
    or (v_recover and not v_can_recover)
    or (v_order.payment_status not in ('pending','failed','paid','refunded'));
  if v_duplicate or v_late then
    v_reason := case when v_duplicate
      then 'A second payment was captured for one store order.'
      else 'Payment was captured after the order reservation ended and inventory could not be restored.' end;
    v_note := case when v_duplicate
      then 'Review refund for extra captured payment ' || p_payment_id || '. The original order remains in fulfilment.'
      else 'Review refund for captured payment ' || p_payment_id || '. Inventory is unavailable or the order was cancelled.' end;
  end if;

  update public.store_orders set
    payment_status = case when v_duplicate and payment_status = 'refunded' then 'refunded' else 'paid' end,
    payment_provider = 'razorpay',
    gateway_amount_paise = case when v_duplicate then gateway_amount_paise else p_amount_paise end,
    payment_reference = case when v_duplicate then payment_reference else p_payment_id end,
    status = case when v_late then 'cancelled' else status end,
    refund_status = case when v_late or v_duplicate then 'requested' else refund_status end,
    refund_payment_reference = case when v_late or v_duplicate then p_payment_id else refund_payment_reference end,
    refund_reason = case when v_late or v_duplicate then v_reason else refund_reason end,
    refund_requested_at = case when v_late or v_duplicate then coalesce(refund_requested_at, now()) else refund_requested_at end,
    refund_resolved_at = case when v_late or v_duplicate then null else refund_resolved_at end,
    refund_admin_note = case when v_late or v_duplicate
      then concat_ws(E'\n', nullif(refund_admin_note, ''), v_note)
      else refund_admin_note end,
    updated_at = now()
  where id = v_order.id;

  if not v_late and not v_duplicate
     and to_regprocedure('public.complete_coupon_redemption(uuid)') is not null then
    execute 'select public.complete_coupon_redemption($1)' using v_order.id;
  end if;

  return jsonb_build_object('updated', true, 'duplicate', false,
    'refundReview', v_late or v_duplicate, 'latePayment', v_late,
    'duplicatePayment', v_duplicate, 'stockRestored', v_recover and v_can_recover,
    'orderId', v_order.id, 'orderNumber', v_order.order_number, 'total', v_order.total);
end;
$$;

-- Keep the original exact-amount entry point for existing deployments and
-- ordinary payments. Customer-fee payments use the separately guarded overload.
create or replace function public.record_razorpay_capture(
  p_gateway_order_id text, p_payment_id text, p_amount_paise bigint, p_currency text
)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.record_razorpay_capture(p_gateway_order_id,p_payment_id,p_amount_paise,p_currency,false,0);
$$;

create or replace function public.mark_store_order_cash_collected(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_order public.store_orders%rowtype;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found or v_order.payment_status <> 'cod'
     or v_order.status not in ('out_for_delivery','delivered','complete') then
    return false;
  end if;
  update public.store_orders set cash_collected_at = coalesce(cash_collected_at, now()), updated_at = now()
   where id = v_order.id;
  return true;
end;
$$;

revoke all on function public.release_pending_checkout_after_cancel(uuid,text) from public, anon, authenticated;
grant execute on function public.release_pending_checkout_after_cancel(uuid,text) to service_role;
revoke all on function public.mark_store_order_cash_collected(uuid) from public, anon, authenticated;
grant execute on function public.mark_store_order_cash_collected(uuid) to service_role;
revoke all on function public.fail_checkout_order(uuid,text) from public, anon, authenticated;
grant execute on function public.fail_checkout_order(uuid,text) to service_role;
revoke all on function public.record_razorpay_capture(text,text,bigint,text,boolean,integer) from public, anon, authenticated;
grant execute on function public.record_razorpay_capture(text,text,bigint,text,boolean,integer) to service_role;
revoke all on function public.record_razorpay_capture(text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.record_razorpay_capture(text,text,bigint,text) to service_role;
