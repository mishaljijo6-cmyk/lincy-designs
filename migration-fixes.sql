-- Apply after schema.sql, migration-orders-and-checkout.sql, and
-- migration-coupons.sql. This idempotent patch repairs payment retry/expiry
-- behavior and keeps released inventory and coupon reservations traceable.

alter table public.store_orders
  add column if not exists customer_note text not null default '',
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

-- Serialize customer checkout attempts, including requests with different
-- idempotency keys. The API first confirms/release-safe-checks any old online
-- payment before it can create a replacement order.
create or replace function public.create_checkout_order(
  p_customer jsonb,
  p_items jsonb,
  p_provider text,
  p_idempotency_key text,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order jsonb;
  v_order_id uuid;
  v_existing_user uuid;
  v_saved_user uuid;
  v_pending_id uuid;
begin
  if p_user_id is null then raise exception 'A signed-in customer is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select user_id into v_existing_user
    from public.store_orders
   where idempotency_key = p_idempotency_key
   for update;
  if found and (v_existing_user is null or v_existing_user <> p_user_id) then
    raise exception 'This checkout belongs to another account';
  end if;

  select id into v_pending_id
    from public.store_orders
   where user_id = p_user_id
     and payment_status = 'pending'
     and idempotency_key is distinct from p_idempotency_key
   order by created_at asc
   limit 1
   for update;
  if found then
    raise exception 'This account already has a pending order. Finish or cancel it before starting another checkout.';
  end if;

  v_order := public.create_checkout_order(p_customer, p_items, p_provider, p_idempotency_key);
  v_order_id := nullif(v_order->>'id', '')::uuid;
  if v_order_id is null then raise exception 'Checkout did not return an order id'; end if;

  update public.store_orders
     set user_id = p_user_id
   where id = v_order_id and (user_id is null or user_id = p_user_id)
   returning user_id into v_saved_user;
  if not found or v_saved_user <> p_user_id then
    raise exception 'This checkout belongs to another account';
  end if;
  return v_order;
end;
$$;
revoke all on function public.create_checkout_order(jsonb,jsonb,text,text,uuid) from public, anon, authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text,uuid) to service_role;

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

-- The authenticated API checks the Razorpay order and confirms that no attempt
-- is created/authorized/captured before calling this service-role-only RPC.
-- Razorpay has no order-cancel endpoint, so a very late bank result is still
-- handled by record_razorpay_capture's inventory recovery/refund-review path.
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
  update public.store_orders set payment_status = 'failed', status = 'cancelled', stock_released_at = now(),
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
    and p_max_customer_fee_bps = 200
    and p_amount_paise = v_expected_paise + ceil(v_expected_paise::numeric * 200 / 10000)::bigint
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

-- Durable Razorpay capture/refund ledger. An order may have more than one
-- successful payment even when the shopper sees one checkout. Keep every
-- provider payment and each refund attempt instead of overwriting one column.
create table if not exists public.store_order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.store_orders(id) on delete cascade,
  razorpay_payment_id text not null unique check (razorpay_payment_id ~ '^pay_[A-Za-z0-9]+$'),
  amount_paise bigint not null check (amount_paise > 0),
  currency text not null check (currency = 'INR'),
  payment_status text not null default 'captured' check (payment_status in ('captured','partially_refunded','refunded')),
  needs_refund_review boolean not null default false,
  refund_review_reason text,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists store_order_payments_order_idx
  on public.store_order_payments(order_id,captured_at,id);
insert into public.store_order_payments(order_id,razorpay_payment_id,amount_paise,currency,payment_status,needs_refund_review,refund_review_reason,captured_at)
select id,payment_reference,coalesce(gateway_amount_paise,total::bigint*100),'INR',
       case when payment_status='refunded' then 'refunded' else 'captured' end,false,null,coalesce(updated_at,created_at,now())
  from public.store_orders where payment_reference ~ '^pay_[A-Za-z0-9]+$'
on conflict(razorpay_payment_id) do nothing;
insert into public.store_order_payments(order_id,razorpay_payment_id,amount_paise,currency,payment_status,needs_refund_review,refund_review_reason,captured_at)
select id,refund_payment_reference,coalesce(gateway_amount_paise,total::bigint*100),'INR','captured',true,
       'Legacy additional capture needs a refund review.',coalesce(updated_at,created_at,now())
  from public.store_orders
 where refund_payment_reference ~ '^pay_[A-Za-z0-9]+$'
   and refund_payment_reference is distinct from payment_reference
on conflict(razorpay_payment_id) do nothing;

create table if not exists public.store_payment_refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.store_orders(id) on delete cascade,
  razorpay_payment_id text not null references public.store_order_payments(razorpay_payment_id) on delete cascade,
  attempt_key text not null unique,
  amount_paise bigint not null check (amount_paise >= 100),
  razorpay_refund_id text unique,
  refund_status text not null default 'reserved' check (refund_status in ('reserved','pending','processed','failed')),
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists store_payment_refunds_payment_idx
  on public.store_payment_refunds(razorpay_payment_id,created_at,id);

alter table public.store_order_payments enable row level security;
alter table public.store_payment_refunds enable row level security;
revoke all on public.store_order_payments,public.store_payment_refunds from public,anon,authenticated;
grant all on public.store_order_payments,public.store_payment_refunds to service_role;
grant select on public.store_order_payments,public.store_payment_refunds to authenticated;
drop policy if exists "Lincy admin reads order payments" on public.store_order_payments;
create policy "Lincy admin reads order payments" on public.store_order_payments for select to authenticated
using (exists(select 1 from public.store_orders o where o.id=order_id and public.is_lincy_admin()));
drop policy if exists "Customers read own order payments" on public.store_order_payments;
create policy "Customers read own order payments" on public.store_order_payments for select to authenticated
using (exists(select 1 from public.store_orders o where o.id=order_id and o.user_id=auth.uid()));
drop policy if exists "Lincy admin reads payment refunds" on public.store_payment_refunds;
create policy "Lincy admin reads payment refunds" on public.store_payment_refunds for select to authenticated
using (exists(select 1 from public.store_orders o where o.id=order_id and public.is_lincy_admin()));
drop policy if exists "Customers read own payment refunds" on public.store_payment_refunds;
create policy "Customers read own payment refunds" on public.store_payment_refunds for select to authenticated
using (exists(select 1 from public.store_orders o where o.id=order_id and o.user_id=auth.uid()));

-- Variant inventory rows represent available stock. store_products.stock is
-- kept as their aggregate so existing catalog cards and search remain correct.
create table if not exists public.store_product_variants (
  product_id text not null references public.store_products(id) on delete cascade,
  size text not null default '',
  color text not null default '',
  stock integer not null default 0 check (stock >= 0),
  updated_at timestamptz not null default now(),
  primary key(product_id,size,color)
);
create index if not exists store_product_variants_product_idx
  on public.store_product_variants(product_id,size,color);
alter table public.store_product_variants enable row level security;
revoke all on public.store_product_variants from public,anon,authenticated;
grant select on public.store_product_variants to anon,authenticated;
grant all on public.store_product_variants to service_role;
drop policy if exists "Anyone reads active product variants" on public.store_product_variants;
create policy "Anyone reads active product variants" on public.store_product_variants for select to anon,authenticated
using (exists(select 1 from public.store_products p where p.id=product_id and p.active=true));

create or replace function public.save_store_product_variants(p_product_id text,p_variants jsonb)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_product public.store_products%rowtype; v_item jsonb; v_size text; v_color text; v_stock integer; v_total integer:=0; v_count integer:=0;
begin
  if not public.is_lincy_admin() then raise exception 'Store administrator access is required'; end if;
  if p_product_id is null or jsonb_typeof(p_variants) is distinct from 'array' or jsonb_array_length(p_variants)>100 then raise exception 'Invalid variant inventory'; end if;
  select * into v_product from public.store_products where id=p_product_id for update;
  if not found then raise exception 'Product not found'; end if;
  -- Keep every option used by an open order restorable. An order can still be
  -- cancelled before shipment, so removing its option would strand the stock
  -- when the cancellation tries to return it.
  if exists (
    select 1
      from public.store_order_items i
      join public.store_orders o on o.id=i.order_id
     where i.product_id=p_product_id
       and o.status in ('new','processing','packed')
       and o.payment_status in ('pending','paid','cod')
       and not exists (
         select 1 from jsonb_array_elements(p_variants) proposed
          where (case when lower(trim(coalesce(proposed->>'size','')))='one size' then '' else trim(coalesce(proposed->>'size','')) end)=coalesce(nullif(lower(trim(i.selected_size)), 'one size'),'')
            and trim(coalesce(proposed->>'color',''))=coalesce(trim(i.selected_color),'')
       )
  ) then raise exception 'Keep size/color combinations used by open orders until those orders are cancelled or fulfilled'; end if;
  delete from public.store_product_variants where product_id=p_product_id;
  for v_item in select value from jsonb_array_elements(p_variants) loop
    v_size:=trim(coalesce(v_item->>'size',''));
    if lower(v_size)='one size' then v_size:=''; end if;
    v_color:=trim(coalesce(v_item->>'color',''));
    if jsonb_typeof(v_item->'stock')<>'number' or coalesce(v_item->>'stock','') !~ '^[0-9]{1,7}$' then raise exception 'Variant stock must be a whole number from 0 to 9,999,999'; end if;
    v_stock:=(v_item->>'stock')::integer;
    if cardinality(v_product.sizes)>0 and (v_size='' or not (v_size=any(v_product.sizes))) or (cardinality(v_product.sizes)=0 and v_size<>'') then raise exception 'Variant size must match the product sizes'; end if;
    if cardinality(v_product.colors)>0 and (v_color='' or not (v_color=any(v_product.colors))) or (cardinality(v_product.colors)=0 and v_color<>'') then raise exception 'Variant color must match the product colors'; end if;
    insert into public.store_product_variants(product_id,size,color,stock,updated_at)
    values(p_product_id,v_size,v_color,v_stock,now());
    v_total:=v_total+v_stock; v_count:=v_count+1;
  end loop;
  update public.store_products set stock=case when v_count>0 then v_total else stock end,updated_at=now() where id=p_product_id;
  return v_count;
end;
$$;
revoke all on function public.save_store_product_variants(text,jsonb) from public,anon;
grant execute on function public.save_store_product_variants(text,jsonb) to authenticated,service_role;

create or replace function public.reserve_store_inventory(p_product_id text,p_size text,p_color text,p_quantity integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_variant public.store_product_variants%rowtype; v_product public.store_products%rowtype; v_size text:=trim(coalesce(p_size,'')); v_color text:=trim(coalesce(p_color,'')); v_configured boolean;
begin
  if lower(v_size)='one size' then v_size:=''; end if;
  select * into v_product from public.store_products where id=p_product_id and active=true for update;
  if not found or p_quantity not between 1 and 10 then return false; end if;
  select exists(select 1 from public.store_product_variants where product_id=p_product_id) into v_configured;
  if v_configured then
    select * into v_variant from public.store_product_variants where product_id=p_product_id and size=v_size and color=v_color for update;
    if not found or v_variant.stock<p_quantity then return false; end if;
    update public.store_product_variants set stock=stock-p_quantity,updated_at=now() where product_id=p_product_id and size=v_size and color=v_color;
  elsif v_product.stock<p_quantity then return false;
  end if;
  update public.store_products set stock=stock-p_quantity,updated_at=now() where id=p_product_id;
  return true;
end;
$$;

create or replace function public.release_store_inventory(p_product_id text,p_size text,p_color text,p_quantity integer)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_size text:=trim(coalesce(p_size,'')); v_color text:=trim(coalesce(p_color,'')); v_product public.store_products%rowtype; v_configured boolean;
begin
  if p_product_id is null or p_quantity<1 then return false; end if;
  if lower(v_size)='one size' then v_size:=''; end if;
  -- Use the same product-then-variant lock order as reservations to avoid
  -- deadlocks when a cancellation races a new checkout.
  select * into v_product from public.store_products where id=p_product_id for update;
  if not found then return false; end if;
  select exists(select 1 from public.store_product_variants where product_id=p_product_id) into v_configured;
  if v_configured then
    update public.store_product_variants set stock=stock+p_quantity,updated_at=now()
     where product_id=p_product_id and size=v_size and color=v_color;
    if not found then raise exception 'The purchased size/color is no longer configured; restore that option before releasing stock'; end if;
  end if;
  update public.store_products set stock=stock+p_quantity,updated_at=now() where id=p_product_id;
  return found;
end;
$$;

create or replace function public.save_store_capture_refund_result(p_attempt_key text,p_refund_id text,p_status text,p_admin_note text default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_refund public.store_payment_refunds%rowtype; v_new_status text;
begin
  if p_status not in ('reserved','pending','processed','failed') or length(coalesce(p_admin_note,''))>1000 then raise exception 'Invalid payment refund result'; end if;
  select * into v_refund from public.store_payment_refunds where attempt_key=p_attempt_key for update;
  if not found then return jsonb_build_object('saved',false); end if;
  if p_refund_id is not null and p_refund_id !~ '^rfnd_[A-Za-z0-9]+$' then raise exception 'Invalid Razorpay refund reference'; end if;
  if v_refund.razorpay_refund_id is not null and p_refund_id is not null and v_refund.razorpay_refund_id<>p_refund_id then raise exception 'Refund reference does not match the saved attempt'; end if;
  v_new_status:=case
    when v_refund.refund_status='processed' then 'processed'
    when p_status='processed' then 'processed'
    when v_refund.refund_status='failed' and p_status='pending' then 'failed'
    else p_status end;
  update public.store_payment_refunds set razorpay_refund_id=coalesce(razorpay_refund_id,p_refund_id),refund_status=v_new_status,
    admin_note=coalesce(nullif(trim(coalesce(p_admin_note,'')),''),admin_note),updated_at=now() where id=v_refund.id;
  if v_new_status='processed' then
    update public.store_order_payments set payment_status=case when
      (select coalesce(sum(r.amount_paise),0) from public.store_payment_refunds r where r.razorpay_payment_id=v_refund.razorpay_payment_id and r.refund_status='processed') >= amount_paise then 'refunded' else 'partially_refunded' end,
      updated_at=now() where razorpay_payment_id=v_refund.razorpay_payment_id;
  end if;
  return jsonb_build_object('saved',true,'status',v_new_status,'refundId',coalesce(v_refund.razorpay_refund_id,p_refund_id));
end;
$$;

create or replace function public.reserve_store_capture_refund(p_order_id uuid,p_payment_id text,p_amount_paise bigint,p_attempt_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_payment public.store_order_payments%rowtype; v_existing public.store_payment_refunds%rowtype; v_reserved bigint; v_key text;
begin
  if p_amount_paise<100 or p_attempt_key !~ '^[A-Za-z0-9_-]{16,80}$' then raise exception 'Invalid refund amount or attempt key'; end if;
  select * into v_payment from public.store_order_payments where order_id=p_order_id and razorpay_payment_id=p_payment_id for update;
  if not found then raise exception 'The captured payment is not attached to this order'; end if;
  select * into v_existing from public.store_payment_refunds where attempt_key=p_attempt_key for update;
  if found then return to_jsonb(v_existing)||jsonb_build_object('reused',true); end if;
  select * into v_existing from public.store_payment_refunds where razorpay_payment_id=p_payment_id and refund_status in ('reserved','pending') order by created_at desc limit 1 for update;
  if found then
    if v_existing.amount_paise<>p_amount_paise then raise exception 'A different refund amount is already being processed for this capture'; end if;
    return to_jsonb(v_existing)||jsonb_build_object('reused',true,'inProgress',true);
  end if;
  select coalesce(sum(amount_paise),0) into v_reserved from public.store_payment_refunds where razorpay_payment_id=p_payment_id and refund_status in ('reserved','pending','processed');
  if p_amount_paise>v_payment.amount_paise-v_reserved then raise exception 'Refund exceeds the remaining captured amount'; end if;
  insert into public.store_payment_refunds(order_id,razorpay_payment_id,attempt_key,amount_paise,refund_status)
  values(p_order_id,p_payment_id,p_attempt_key,p_amount_paise,'reserved') returning * into v_existing;
  return to_jsonb(v_existing)||jsonb_build_object('reused',false,'inProgress',false);
end;
$$;

create or replace function public.record_store_payment_refund_event(
  p_order_id uuid,p_payment_id text,p_attempt_key text,p_refund_id text,p_amount_paise bigint,p_status text,p_admin_note text default null
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_payment public.store_order_payments%rowtype; v_refund public.store_payment_refunds%rowtype; v_status text; v_processed bigint;
begin
  if p_status not in ('reserved','pending','processed','failed') or p_amount_paise<100
    or p_attempt_key !~ '^[A-Za-z0-9_-]{8,80}$' or length(coalesce(p_admin_note,''))>1000 then raise exception 'Invalid payment refund event'; end if;
  if p_refund_id is not null and p_refund_id !~ '^rfnd_[A-Za-z0-9]+$' then raise exception 'Invalid Razorpay refund reference'; end if;
  select * into v_payment from public.store_order_payments where order_id=p_order_id and razorpay_payment_id=p_payment_id for update;
  if not found then return jsonb_build_object('saved',false); end if;
  select * into v_refund from public.store_payment_refunds where attempt_key=p_attempt_key for update;
  if found then
    if v_refund.order_id<>p_order_id or v_refund.razorpay_payment_id<>p_payment_id or v_refund.amount_paise<>p_amount_paise
      or (v_refund.razorpay_refund_id is not null and p_refund_id is not null and v_refund.razorpay_refund_id<>p_refund_id) then
      raise exception 'Refund event does not match the saved payment attempt';
    end if;
    v_status:=case when v_refund.refund_status='processed' then 'processed' when p_status='processed' then 'processed'
      when v_refund.refund_status='failed' and p_status='pending' then 'failed' else p_status end;
    update public.store_payment_refunds set razorpay_refund_id=coalesce(razorpay_refund_id,p_refund_id),refund_status=v_status,
      admin_note=coalesce(nullif(trim(coalesce(p_admin_note,'')),''),admin_note),updated_at=now() where id=v_refund.id;
  else
    insert into public.store_payment_refunds(order_id,razorpay_payment_id,attempt_key,amount_paise,razorpay_refund_id,refund_status,admin_note)
    values(p_order_id,p_payment_id,p_attempt_key,p_amount_paise,p_refund_id,p_status,nullif(trim(coalesce(p_admin_note,'')),'')) returning * into v_refund;
    v_status:=v_refund.refund_status;
  end if;
  select coalesce(sum(amount_paise),0) into v_processed from public.store_payment_refunds
   where razorpay_payment_id=p_payment_id and refund_status='processed';
  if v_processed>0 then
    update public.store_order_payments set payment_status=case when v_processed>=amount_paise then 'refunded' else 'partially_refunded' end,updated_at=now()
     where razorpay_payment_id=p_payment_id;
  end if;
  return jsonb_build_object('saved',true,'status',v_status,'refundId',coalesce(v_refund.razorpay_refund_id,p_refund_id));
end;
$$;

revoke all on function public.save_store_capture_refund_result(text,text,text,text) from public,anon,authenticated;
revoke all on function public.reserve_store_capture_refund(uuid,text,bigint,text) from public,anon,authenticated;
revoke all on function public.record_store_payment_refund_event(uuid,text,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.save_store_capture_refund_result(text,text,text,text) to service_role;
grant execute on function public.reserve_store_capture_refund(uuid,text,bigint,text) to service_role;
grant execute on function public.record_store_payment_refund_event(uuid,text,text,text,bigint,text,text) to service_role;
revoke all on function public.reserve_store_inventory(text,text,text,integer) from public,anon,authenticated;
revoke all on function public.release_store_inventory(text,text,text,integer) from public,anon,authenticated;
grant execute on function public.reserve_store_inventory(text,text,text,integer) to service_role;
grant execute on function public.release_store_inventory(text,text,text,integer) to service_role;

-- Final checkout implementation: all variants are checked and reserved inside
-- the same transaction as the order and line-item inserts.
create or replace function public.create_checkout_order(
  p_customer jsonb,p_items jsonb,p_provider text,p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_order public.store_orders%rowtype; v_product public.store_products%rowtype; v_item jsonb; v_line record;
  v_qty integer; v_subtotal integer:=0; v_gst_amount integer:=0; v_tax_rate integer:=0; v_shipping integer:=99;
  v_count integer:=0; v_order_id uuid; v_number text; v_size text; v_color text;
  v_customer_name text:=trim(coalesce(p_customer->>'name',''));
  v_email text:=lower(trim(coalesce(p_customer->>'email','')));
  v_phone text:=trim(coalesce(p_customer->>'phone',''));
  v_customer_note text:=trim(coalesce(p_customer->>'note',''));
begin
  if p_provider not in ('razorpay','cod') then raise exception 'Invalid payment method'; end if;
  if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>20 then raise exception 'Invalid items'; end if;
  if length(v_customer_name) not between 2 and 100 or v_email !~* '^[^@ ]+@[^@ ]+\.[^@ ]+$' or v_phone !~ '^[0-9+() -]{10,20}$' then raise exception 'Invalid customer details'; end if;
  if length(v_customer_note)>500 then raise exception 'Order note is too long'; end if;
  if length(trim(coalesce(p_customer->>'address',''))) not between 4 and 300
    or length(trim(coalesce(p_customer->>'city',''))) not between 2 and 100
    or length(trim(coalesce(p_customer->>'state',''))) not between 2 and 100
    or trim(coalesce(p_customer->>'pincode','')) !~ '^[0-9]{6}$' then raise exception 'Invalid delivery address'; end if;

  if p_idempotency_key is not null then
    select * into v_order from public.store_orders where idempotency_key=p_idempotency_key for update;
    if found then
      if v_order.payment_status='failed' then
        if v_order.payment_provider is distinct from p_provider then raise exception 'An expired order must be retried with its original payment method'; end if;
        if v_order.stock_released_at is not null then
          for v_line in
            select product_id,coalesce(selected_size,'' ) as selected_size,coalesce(selected_color,'') as selected_color,sum(quantity)::integer as quantity
              from public.store_order_items where order_id=v_order.id and product_id is not null
             group by product_id,selected_size,selected_color order by product_id,selected_size,selected_color
          loop
            if not public.reserve_store_inventory(v_line.product_id,v_line.selected_size,v_line.selected_color,v_line.quantity) then
              raise exception 'A selected size or color is no longer available in the requested quantity';
            end if;
          end loop;
          update public.store_orders set stock_released_at=null where id=v_order.id;
        end if;
        update public.store_orders set payment_status=case when p_provider='cod' then 'cod' else 'pending' end,status='new',
          customer_note=v_customer_note,payment_provider=p_provider,
          razorpay_order_id=case when p_provider='razorpay' then v_order.razorpay_order_id else null end,
          payment_reference=null,gateway_amount_paise=null
        where id=v_order.id;
        select * into v_order from public.store_orders where id=v_order.id;
      end if;
      if v_order.payment_status='pending' and v_order.status='new' then
        update public.store_orders set customer_note=v_customer_note where id=v_order.id;
        select * into v_order from public.store_orders where id=v_order.id;
      end if;
      return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider,'razorpay_order_id',v_order.razorpay_order_id);
    end if;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    if coalesce(v_item->>'quantity','') !~ '^[0-9]{1,2}$' then raise exception 'Invalid quantity'; end if;
    v_qty:=(v_item->>'quantity')::integer;
    if v_qty not between 1 and 10 then raise exception 'Invalid quantity'; end if;
    select * into v_product from public.store_products where id=v_item->>'productId' and active=true for update;
    if not found then raise exception 'A selected product is unavailable'; end if;
    v_size:=trim(coalesce(v_item->>'size','')); if lower(v_size)='one size' then v_size:=''; end if;
    v_color:=trim(coalesce(v_item->>'color',''));
    if v_size<>'' and not (v_size=any(v_product.sizes)) then raise exception 'Invalid size'; end if;
    if v_size='' and cardinality(v_product.sizes)>0 then raise exception 'Choose a size'; end if;
    if v_color<>'' and not (v_color=any(v_product.colors)) then raise exception 'Invalid color'; end if;
    if v_color='' and cardinality(v_product.colors)>0 then raise exception 'Choose a color'; end if;
    if not public.reserve_store_inventory(v_product.id,v_size,v_color,v_qty) then
      raise exception 'Insufficient stock for the selected size and color of %',v_product.name;
    end if;
    v_subtotal:=v_subtotal+v_product.price*v_qty;
    v_tax_rate:=case when v_product.price<=2500 then 5 else 18 end;
    v_gst_amount:=v_gst_amount+round((v_product.price::numeric*v_qty*v_tax_rate)/(100+v_tax_rate))::integer;
    v_count:=v_count+1;
  end loop;
  if v_count<>jsonb_array_length(p_items) then raise exception 'Invalid product list'; end if;
  v_number:='LD-'||to_char(now(),'YYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.store_orders(user_id,order_number,idempotency_key,customer_name,email,customer_note,phone,address,city,state,pincode,subtotal,gst_amount,shipping,total,payment_status,payment_provider)
  values(null,v_number,p_idempotency_key,v_customer_name,v_email,v_customer_note,v_phone,trim(p_customer->>'address'),trim(p_customer->>'city'),trim(p_customer->>'state'),trim(p_customer->>'pincode'),v_subtotal,v_gst_amount,v_shipping,v_subtotal+v_shipping,case when p_provider='cod' then 'cod' else 'pending' end,p_provider)
  returning id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.store_products where id=v_item->>'productId';
    v_qty:=(v_item->>'quantity')::integer; v_size:=trim(coalesce(v_item->>'size','')); if lower(v_size)='one size' then v_size:=''; end if;
    v_tax_rate:=case when v_product.price<=2500 then 5 else 18 end;
    insert into public.store_order_items(order_id,product_id,product_name,unit_price,quantity,gst_rate,gst_amount,selected_size,selected_color,image_url)
    values(v_order_id,v_product.id,v_product.name,v_product.price,v_qty,v_tax_rate,round((v_product.price::numeric*v_qty*v_tax_rate)/(100+v_tax_rate))::integer,nullif(v_size,''),nullif(trim(coalesce(v_item->>'color','')),''),v_product.image_url);
  end loop;
  select * into v_order from public.store_orders where id=v_order_id;
  return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider);
end;
$$;
revoke all on function public.create_checkout_order(jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text) to service_role;

create or replace function public.fail_checkout_order(p_order_id uuid,p_razorpay_order_id text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id=p_order_id for update;
  if not found or v_order.payment_status<>'pending' or v_order.stock_released_at is not null then return false; end if;
  if p_razorpay_order_id is not null and v_order.razorpay_order_id is distinct from p_razorpay_order_id then return false; end if;
  if v_order.payment_provider='razorpay' and v_order.razorpay_order_id is not null and v_order.created_at>now()-interval '45 minutes' then return false; end if;
  update public.store_orders set payment_status='failed',stock_released_at=now(),razorpay_order_creation_token=null,razorpay_order_creating_at=null,updated_at=now() where id=v_order.id;
  for v_line in select product_id,coalesce(selected_size,'') as selected_size,coalesce(selected_color,'') as selected_color,sum(quantity)::integer as quantity
    from public.store_order_items where order_id=v_order.id and product_id is not null group by product_id,selected_size,selected_color order by product_id,selected_size,selected_color loop
    perform public.release_store_inventory(v_line.product_id,v_line.selected_size,v_line.selected_color,v_line.quantity);
  end loop;
  if to_regprocedure('public.release_coupon_redemption(uuid)') is not null then perform public.release_coupon_redemption(v_order.id); end if;
  return true;
end;
$$;

create or replace function public.release_pending_checkout_after_cancel(p_order_id uuid,p_razorpay_order_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id=p_order_id for update;
  if not found or v_order.payment_status<>'pending' or v_order.payment_provider<>'razorpay'
     or v_order.razorpay_order_id is distinct from p_razorpay_order_id or v_order.stock_released_at is not null then return false; end if;
  update public.store_orders set payment_status='failed',status='cancelled',stock_released_at=now(),razorpay_order_creation_token=null,razorpay_order_creating_at=null,updated_at=now() where id=v_order.id;
  for v_line in select product_id,coalesce(selected_size,'') as selected_size,coalesce(selected_color,'') as selected_color,sum(quantity)::integer as quantity
    from public.store_order_items where order_id=v_order.id and product_id is not null group by product_id,selected_size,selected_color order by product_id,selected_size,selected_color loop
    perform public.release_store_inventory(v_line.product_id,v_line.selected_size,v_line.selected_color,v_line.quantity);
  end loop;
  if to_regprocedure('public.release_coupon_redemption(uuid)') is not null then perform public.release_coupon_redemption(v_order.id); end if;
  return true;
end;
$$;

create or replace function public.record_razorpay_capture(
  p_gateway_order_id text,p_payment_id text,p_amount_paise bigint,p_currency text,p_allow_customer_fee boolean,p_max_customer_fee_bps integer
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_order public.store_orders%rowtype; v_payment public.store_order_payments%rowtype; v_line record; v_product public.store_products%rowtype;
  v_duplicate boolean:=false; v_late boolean:=false; v_recover boolean:=false; v_can_recover boolean:=true;
  v_reason text; v_note text; v_expected_paise bigint; v_inserted integer;
begin
  if p_gateway_order_id is null or length(p_gateway_order_id)>100 or p_payment_id is null or p_payment_id !~ '^pay_[A-Za-z0-9]+$'
    or p_currency<>'INR' or p_amount_paise<1 then return jsonb_build_object('ignored',true); end if;
  select * into v_order from public.store_orders where razorpay_order_id=p_gateway_order_id for update;
  if not found then return jsonb_build_object('ignored',true); end if;
  v_expected_paise:=v_order.total::bigint*100;
  if p_amount_paise<>v_expected_paise and not (p_allow_customer_fee is true and p_max_customer_fee_bps=200
    and p_amount_paise=v_expected_paise+ceil(v_expected_paise::numeric*200/10000)::bigint) then return jsonb_build_object('ignored',true); end if;
  select * into v_payment from public.store_order_payments where razorpay_payment_id=p_payment_id;
  if found then
    if v_payment.order_id<>v_order.id then return jsonb_build_object('ignored',true); end if;
    return jsonb_build_object('duplicate',true,'refundReview',v_payment.needs_refund_review,'latePayment',v_order.status='cancelled',
      'duplicatePayment',v_payment.needs_refund_review and v_order.status<>'cancelled','orderId',v_order.id,'orderNumber',v_order.order_number);
  end if;
  select exists(select 1 from public.store_order_payments where order_id=v_order.id) or
         (v_order.payment_reference is not null and v_order.payment_reference<>p_payment_id) into v_duplicate;
  v_recover:=v_order.payment_status='failed' and v_order.status<>'cancelled';
  if v_recover and v_order.stock_released_at is not null then
    -- Check every exact variant before changing any inventory. The order row
    -- and product locks serialize parallel captures and checkout reservations.
    for v_line in select product_id from public.store_order_items where order_id=v_order.id and product_id is not null group by product_id order by product_id loop
      select * into v_product from public.store_products where id=v_line.product_id for update;
      if not found or v_product.active is distinct from true then v_can_recover:=false; end if;
    end loop;
    if v_can_recover then
      for v_line in select product_id,coalesce(selected_size,'') as selected_size,coalesce(selected_color,'') as selected_color,sum(quantity)::integer as quantity
        from public.store_order_items where order_id=v_order.id and product_id is not null group by product_id,selected_size,selected_color order by product_id,selected_size,selected_color loop
        select * into v_product from public.store_products where id=v_line.product_id for update;
        if v_product.stock<v_line.quantity then v_can_recover:=false; exit; end if;
        if exists(select 1 from public.store_product_variants where product_id=v_line.product_id) and not exists(
          select 1 from public.store_product_variants where product_id=v_line.product_id and size=case when lower(v_line.selected_size)='one size' then '' else v_line.selected_size end and color=v_line.selected_color and stock>=v_line.quantity) then
          v_can_recover:=false; exit;
        end if;
      end loop;
    end if;
    if v_can_recover then
      for v_line in select product_id,coalesce(selected_size,'') as selected_size,coalesce(selected_color,'') as selected_color,sum(quantity)::integer as quantity
        from public.store_order_items where order_id=v_order.id and product_id is not null group by product_id,selected_size,selected_color order by product_id,selected_size,selected_color loop
        if not public.reserve_store_inventory(v_line.product_id,v_line.selected_size,v_line.selected_color,v_line.quantity) then raise exception 'Could not restore inventory for captured payment'; end if;
      end loop;
      update public.store_orders set stock_released_at=null where id=v_order.id;
    end if;
  end if;
  v_late:=v_order.status='cancelled' or (v_recover and not v_can_recover) or v_order.payment_status not in ('pending','failed','paid','refunded');
  if v_duplicate then v_reason:='A second payment was captured for one store order.'; v_note:='Refund the additional captured payment '||p_payment_id||'.';
  elsif v_late then v_reason:='Payment was captured after the order reservation ended and inventory could not be restored.'; v_note:='Review refund for late capture '||p_payment_id||'.'; end if;

  insert into public.store_order_payments(order_id,razorpay_payment_id,amount_paise,currency,needs_refund_review,refund_review_reason)
  values(v_order.id,p_payment_id,p_amount_paise,p_currency,v_duplicate or v_late,v_reason) on conflict(razorpay_payment_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then
    select * into v_payment from public.store_order_payments where razorpay_payment_id=p_payment_id;
    if not found or v_payment.order_id<>v_order.id then return jsonb_build_object('ignored',true); end if;
    return jsonb_build_object('duplicate',true,'refundReview',v_payment.needs_refund_review,'orderId',v_order.id,'orderNumber',v_order.order_number);
  end if;
  update public.store_orders set payment_status='paid',payment_provider='razorpay',
    gateway_amount_paise=case when v_duplicate then gateway_amount_paise else p_amount_paise end,
    payment_reference=case when v_duplicate then payment_reference else p_payment_id end,
    status=case when v_late then 'cancelled' else status end,
    refund_status=case when v_late then 'requested' else refund_status end,
    refund_payment_reference=case when v_late then p_payment_id else refund_payment_reference end,
    refund_reason=case when v_late then v_reason else refund_reason end,
    refund_requested_at=case when v_late then coalesce(refund_requested_at,now()) else refund_requested_at end,
    refund_resolved_at=case when v_late then null else refund_resolved_at end,
    refund_admin_note=case when v_late then concat_ws(E'\n',nullif(refund_admin_note,''),v_note) else refund_admin_note end,
    updated_at=now() where id=v_order.id;
  if not v_late and not v_duplicate and to_regprocedure('public.complete_coupon_redemption(uuid)') is not null then
    execute 'select public.complete_coupon_redemption($1)' using v_order.id;
  end if;
  return jsonb_build_object('updated',true,'duplicate',false,'refundReview',v_late or v_duplicate,'latePayment',v_late,
    'duplicatePayment',v_duplicate,'stockRestored',v_recover and v_can_recover,'orderId',v_order.id,'orderNumber',v_order.order_number,'total',v_order.total);
end;
$$;

create or replace function public.cancel_store_order(p_order_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id=p_order_id for update;
  if not found then return false; end if;
  if v_order.status='cancelled' then return true; end if;
  if v_order.status in ('shipped','out_for_delivery','delivered','complete') then raise exception 'Orders already handed to the carrier cannot be cancelled here'; end if;
  if v_order.payment_status='pending' then raise exception 'Check the payment before cancelling this order'; end if;
  update public.store_orders set status='cancelled',updated_at=now(),
    refund_status=case when payment_status='paid' then 'requested' else refund_status end,
    refund_reason=case when payment_status='paid' then 'Order cancelled by the store owner.' else refund_reason end,
    refund_requested_at=case when payment_status='paid' then now() else refund_requested_at end,
    refund_admin_note=case when payment_status='paid' then 'Payment was captured. Review the payment ledger and submit the refund through Razorpay.' else refund_admin_note end
  where id=v_order.id;
  if v_order.payment_status in ('paid','cod') then
    for v_line in select product_id,coalesce(selected_size,'') as selected_size,coalesce(selected_color,'') as selected_color,sum(quantity)::integer as quantity
      from public.store_order_items where order_id=v_order.id and product_id is not null group by product_id,selected_size,selected_color order by product_id,selected_size,selected_color loop
      perform public.release_store_inventory(v_line.product_id,v_line.selected_size,v_line.selected_color,v_line.quantity);
    end loop;
  end if;
  return true;
end;
$$;

revoke all on function public.record_razorpay_capture(text,text,bigint,text,boolean,integer) from public,anon,authenticated;
grant execute on function public.record_razorpay_capture(text,text,bigint,text,boolean,integer) to service_role;
revoke all on function public.record_razorpay_capture(text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.record_razorpay_capture(text,text,bigint,text) to service_role;
revoke all on function public.cancel_store_order(uuid) from public,anon,authenticated;
grant execute on function public.cancel_store_order(uuid) to service_role;
notify pgrst, 'reload schema';
