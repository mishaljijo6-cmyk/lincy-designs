-- Run this in Supabase SQL Editor after the base schema.sql.
-- Adds GST persistence, account-owned checkout, order tracking/refunds, gallery
-- fields, and a protected public-image bucket for product photos.

alter table public.store_products
  add column if not exists image_gallery text[] not null default '{}',
  add column if not exists color_images jsonb not null default '{}'::jsonb;

alter table public.store_orders
  add column if not exists gst_amount integer not null default 0;
alter table public.store_orders
  add column if not exists idempotency_key text,
  add column if not exists razorpay_order_id text,
  add column if not exists razorpay_order_creation_token text,
  add column if not exists razorpay_order_creating_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.store_order_items
  add column if not exists gst_rate integer not null default 0,
  add column if not exists gst_amount integer not null default 0;

-- Fill tax detail for existing orders that predate GST persistence.
update public.store_order_items
   set gst_rate = case when unit_price <= 2500 then 5 else 18 end,
       gst_amount = round((unit_price::numeric * quantity *
         case when unit_price <= 2500 then 5 else 18 end) /
         (100 + case when unit_price <= 2500 then 5 else 18 end))::integer
 where gst_rate = 0 and gst_amount = 0;

update public.store_orders o
   set gst_amount = coalesce((
     select sum(i.gst_amount) from public.store_order_items i where i.order_id = o.id
   ), 0)
 where o.gst_amount = 0 and exists (
   select 1 from public.store_order_items i where i.order_id = o.id
 );

alter table public.store_orders
  add column if not exists user_id uuid,
  add column if not exists customer_note text not null default '',
  add column if not exists shipping_carrier text,
  add column if not exists tracking_number text,
  add column if not exists tracking_url text,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists refund_status text not null default 'none',
  add column if not exists refund_reason text,
  add column if not exists refund_requested_at timestamptz,
  add column if not exists refund_resolved_at timestamptz,
  add column if not exists refund_admin_note text,
  add column if not exists refund_reference text,
  add column if not exists refund_attempt_key text,
  add column if not exists refund_payment_reference text,
  add column if not exists refund_amount_paise bigint,
  add column if not exists gateway_amount_paise bigint,
  add column if not exists stock_released_at timestamptz,
  add column if not exists cash_collected_at timestamptz,
  add column if not exists payment_reconciled_at timestamptz;

create table if not exists public.store_product_variants (
 product_id text not null references public.store_products(id) on delete cascade,
 size text not null default '',
 color text not null default '',
 stock integer not null default 0 check (stock >= 0),
 updated_at timestamptz not null default now(),
 primary key(product_id,size,color)
);
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

-- Product photos can be uploaded from the admin device. Only the store owner
-- can write files; shoppers can read the public product images.
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
drop policy if exists "Lincy admin updates orders" on public.store_orders;
drop policy if exists "Lincy admin reads order items" on public.store_order_items;
create policy "Lincy admin reads order items" on public.store_order_items for select to authenticated
  using (exists (select 1 from public.store_orders o where o.id = order_id and public.is_lincy_admin()));
drop policy if exists "Lincy admin reads subscribers" on public.store_subscribers;
create policy "Lincy admin reads subscribers" on public.store_subscribers for select to authenticated
  using (public.is_lincy_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-product-images', 'store-product-images', true, 10485760,
        array['image/jpeg','image/png','image/webp','image/avif'])
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public reads store product images" on storage.objects;
create policy "Public reads store product images" on storage.objects
  for select to anon, authenticated using (bucket_id = 'store-product-images');
drop policy if exists "Store owner uploads product images" on storage.objects;
create policy "Store owner uploads product images" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'store-product-images' and public.is_lincy_admin()
  );
drop policy if exists "Store owner updates product images" on storage.objects;
create policy "Store owner updates product images" on storage.objects
  for update to authenticated using (
    bucket_id = 'store-product-images' and public.is_lincy_admin()
  ) with check (
    bucket_id = 'store-product-images' and public.is_lincy_admin()
  );
drop policy if exists "Store owner deletes product images" on storage.objects;
create policy "Store owner deletes product images" on storage.objects
  for delete to authenticated using (
    bucket_id = 'store-product-images' and public.is_lincy_admin()
  );

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'store_orders_user_id_fkey'
      and conrelid = 'public.store_orders'::regclass
  ) then
    alter table public.store_orders
      add constraint store_orders_user_id_fkey
      foreign key (user_id) references auth.users(id) on delete set null;
  end if;
end $$;

alter table public.store_orders drop constraint if exists store_orders_status_check;
alter table public.store_orders add constraint store_orders_status_check
  check (status in ('new','processing','packed','shipped','out_for_delivery','delivered','complete','cancelled'));
alter table public.store_orders drop constraint if exists store_orders_refund_status_check;
alter table public.store_orders add constraint store_orders_refund_status_check
  check (refund_status in ('none','requested','approved','rejected','processed'));
alter table public.store_orders drop constraint if exists store_orders_payment_status_check;
alter table public.store_orders add constraint store_orders_payment_status_check
  check (payment_status in ('pending','paid','failed','refunded','cod'));

create index if not exists store_orders_user_created_idx
  on public.store_orders(user_id, created_at desc) where user_id is not null;
create index if not exists store_orders_refund_queue_idx
  on public.store_orders(refund_status, created_at desc) where refund_status <> 'none';

drop policy if exists "Customers read their own orders" on public.store_orders;
drop policy if exists "Lincy admin reads orders" on public.store_orders;
create policy "Lincy admin reads orders" on public.store_orders for select to authenticated
using (public.is_lincy_admin());
create policy "Customers read their own orders" on public.store_orders for select to authenticated
using (user_id = auth.uid());
drop policy if exists "Customers read their own order items" on public.store_order_items;
drop policy if exists "Lincy admin reads order items" on public.store_order_items;
create policy "Lincy admin reads order items" on public.store_order_items for select to authenticated
using (exists (select 1 from public.store_orders o where o.id = order_id and public.is_lincy_admin()));
create policy "Customers read their own order items" on public.store_order_items for select to authenticated
using (exists (
  select 1 from public.store_orders o
  where o.id = order_id and o.user_id = auth.uid()
));
grant select on public.store_orders, public.store_order_items to authenticated;
grant all on public.store_orders, public.store_order_items to service_role;

create table if not exists public.store_api_rate_limits (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now()
);
alter table public.store_api_rate_limits enable row level security;
revoke all on public.store_api_rate_limits from public, anon, authenticated;
grant all on public.store_api_rate_limits to service_role;

create or replace function public.consume_store_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if p_key is null or length(p_key) not between 3 and 200
    or p_limit not between 1 and 1000 or p_window_seconds not between 1 and 86400 then
    raise exception 'Invalid rate limit parameters';
  end if;
  insert into public.store_api_rate_limits(rate_key,window_started_at,request_count,updated_at)
  values(p_key,now(),1,now())
  on conflict(rate_key) do update set
    request_count=case
      when store_api_rate_limits.window_started_at <= now()-(p_window_seconds * interval '1 second') then 1
      else store_api_rate_limits.request_count+1
    end,
    window_started_at=case
      when store_api_rate_limits.window_started_at <= now()-(p_window_seconds * interval '1 second') then now()
      else store_api_rate_limits.window_started_at
    end,
    updated_at=now()
  returning request_count into v_count;
  return v_count <= p_limit;
end;
$$;

-- Replace the checkout routine with a version that never expires online
-- payment holds without first asking Razorpay whether money was captured.
create or replace function public.create_checkout_order(
  p_customer jsonb, p_items jsonb, p_provider text, p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_order public.store_orders%rowtype;
  v_product public.store_products%rowtype;
  v_item jsonb;
  v_qty integer;
  v_subtotal integer := 0;
  v_gst_amount integer := 0;
  v_tax_rate integer := 0;
  v_shipping integer := 0;
  v_count integer := 0;
  v_order_id uuid;
  v_number text;
  v_line record;
  v_customer_name text := trim(coalesce(p_customer->>'name',''));
  v_email text := lower(trim(coalesce(p_customer->>'email','')));
  v_phone text := trim(coalesce(p_customer->>'phone',''));
  v_customer_note text := trim(coalesce(p_customer->>'note',''));
begin
  if p_provider not in ('razorpay','cod') then raise exception 'Invalid payment method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 20 then raise exception 'Invalid items'; end if;
  if length(v_customer_name) not between 2 and 100 or v_email !~* '^[^@ ]+@[^@ ]+\.[^@ ]+$' or v_phone !~ '^[0-9+() -]{10,20}$' then raise exception 'Invalid customer details'; end if;
  if length(v_customer_note) > 500 then raise exception 'Order note is too long'; end if;
  if length(trim(coalesce(p_customer->>'address',''))) not between 4 and 300
    or length(trim(coalesce(p_customer->>'city',''))) not between 2 and 100
    or length(trim(coalesce(p_customer->>'state',''))) not between 2 and 100
    or trim(coalesce(p_customer->>'pincode','')) !~ '^[0-9]{6}$' then raise exception 'Invalid delivery address'; end if;

  if p_idempotency_key is not null then
    select * into v_order from public.store_orders where idempotency_key = p_idempotency_key for update;
    if found then
      if v_order.payment_status = 'failed' then
        if v_order.payment_provider is distinct from p_provider then
          raise exception 'An expired order must be retried with its original payment method';
        end if;
        for v_line in select product_id,quantity from public.store_order_items where order_id=v_order.id and product_id is not null order by product_id loop
          select * into v_product from public.store_products where id=v_line.product_id and active=true for update;
          if not found or v_product.stock < v_line.quantity then raise exception 'A selected product is no longer available in the requested quantity'; end if;
          update public.store_products set stock=stock-v_line.quantity where id=v_product.id;
        end loop;
        update public.store_orders set payment_status=case when p_provider='cod' then 'cod' else 'pending' end,
          customer_note=v_customer_note,
          payment_provider=p_provider,
          razorpay_order_id=case when p_provider='razorpay' then v_order.razorpay_order_id else null end,
          payment_reference=null where id=v_order.id;
        select * into v_order from public.store_orders where id=v_order.id;
      end if;
      if v_order.payment_status = 'pending' then
        update public.store_orders set customer_note=v_customer_note where id=v_order.id;
        select * into v_order from public.store_orders where id=v_order.id;
      end if;
      return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider,'razorpay_order_id',v_order.razorpay_order_id);
    end if;
  end if;

  -- Lock products in a stable order and reserve inventory in this transaction.
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 10 then raise exception 'Invalid quantity'; end if;
    select * into v_product from public.store_products where id = v_item->>'productId' and active = true for update;
    if not found then raise exception 'A selected product is unavailable'; end if;
    if v_product.stock < v_qty then raise exception 'Insufficient stock for %', v_product.name; end if;
    if lower(trim(coalesce(v_item->>'size',''))) not in ('','one size') and not (trim(v_item->>'size') = any(v_product.sizes)) then raise exception 'Invalid size'; end if;
    if coalesce(v_item->>'color','') <> '' and not (v_item->>'color' = any(v_product.colors)) then raise exception 'Invalid color'; end if;
    update public.store_products set stock=stock-v_qty where id=v_product.id;
    v_subtotal := v_subtotal + v_product.price * v_qty;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    v_gst_amount := v_gst_amount + round((v_product.price::numeric*v_qty*v_tax_rate)/(100+v_tax_rate))::integer;
    v_count := v_count + 1;
  end loop;
  if v_count <> jsonb_array_length(p_items) then raise exception 'Invalid product list'; end if;
  v_shipping := 99;
  v_number := 'LD-'||to_char(now(),'YYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.store_orders(order_number,idempotency_key,customer_name,email,customer_note,phone,address,city,state,pincode,subtotal,gst_amount,shipping,total,payment_status,payment_provider)
  values(v_number,p_idempotency_key,v_customer_name,v_email,v_customer_note,v_phone,trim(p_customer->>'address'),trim(p_customer->>'city'),trim(p_customer->>'state'),trim(p_customer->>'pincode'),v_subtotal,v_gst_amount,v_shipping,v_subtotal+v_shipping,case when p_provider='cod' then 'cod' else 'pending' end,p_provider)
  returning id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.store_products where id=v_item->>'productId';
    v_qty := (v_item->>'quantity')::integer;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    insert into public.store_order_items(order_id,product_id,product_name,unit_price,quantity,gst_rate,gst_amount,selected_size,selected_color,image_url)
    values(v_order_id,v_product.id,v_product.name,v_product.price,v_qty,v_tax_rate,round((v_product.price::numeric*v_qty*v_tax_rate)/(100+v_tax_rate))::integer,nullif(case when lower(trim(coalesce(v_item->>'size','')))='one size' then '' else trim(coalesce(v_item->>'size','')) end,''),nullif(v_item->>'color',''),v_product.image_url);
  end loop;
  select * into v_order from public.store_orders where id=v_order_id;
  return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider);
end;
$$;

-- Release an order's stock reservation once, and only while no payment has
-- been recorded. Payment webhooks can safely race this function because both
-- paths lock the same order row.
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

-- Keep the exact-amount helper used by deployments without customer-paid fees.
create or replace function public.record_razorpay_capture(
  p_gateway_order_id text, p_payment_id text, p_amount_paise bigint, p_currency text
)
returns jsonb language sql security definer set search_path=public,pg_temp as $$
  select public.record_razorpay_capture(p_gateway_order_id,p_payment_id,p_amount_paise,p_currency,false,0);
$$;

-- A short database lease prevents two concurrent requests from creating
-- separate Razorpay orders for the same store order.
create or replace function public.claim_razorpay_order(p_order_id uuid, p_token text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_claimed uuid;
begin
  if p_token is null or length(p_token) not between 20 and 100 then return false; end if;
  update public.store_orders
     set razorpay_order_creation_token = p_token,
         razorpay_order_creating_at = now(),
         updated_at = now()
   where id = p_order_id
     and payment_status = 'pending'
     and razorpay_order_id is null
     and (razorpay_order_creation_token is null
          or razorpay_order_creating_at < now() - interval '2 minutes')
   returning id into v_claimed;
  return v_claimed is not null;
end;
$$;

create or replace function public.cancel_store_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id = p_order_id for update;
  if not found then return false; end if;
  if v_order.status = 'cancelled' then return true; end if;
  if v_order.status in ('shipped','out_for_delivery','delivered','complete') then
    raise exception 'Orders already handed to the carrier cannot be cancelled here';
  end if;
  if v_order.payment_status = 'pending' then raise exception 'Check the payment before cancelling this order'; end if;
  update public.store_orders set status = 'cancelled', updated_at = now(),
    refund_status = case when payment_status = 'paid' then 'requested' else refund_status end,
    refund_reason = case when payment_status = 'paid' then 'Order cancelled by the store owner.' else refund_reason end,
    refund_requested_at = case when payment_status = 'paid' then now() else refund_requested_at end,
    refund_admin_note = case when payment_status = 'paid' then 'Payment was captured. Initiate the refund in Razorpay and save its final status.' else refund_admin_note end
   where id = v_order.id;
  if v_order.payment_status in ('paid','cod') then
    for v_line in select product_id, quantity from public.store_order_items where order_id = v_order.id and product_id is not null loop
      update public.store_products set stock = stock + v_line.quantity where id = v_line.product_id;
    end loop;
  end if;
  return true;
end;
$$;

-- Apply fulfilment transitions under the order-row lock so a payment callback
-- cannot race an admin action and allow an unpaid order to ship.
create or replace function public.update_store_order_status(p_order_id uuid, p_status text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_order public.store_orders%rowtype; v_allowed boolean := false;
begin
  if p_status not in ('new','processing','packed','shipped','out_for_delivery','delivered','complete','cancelled') then
    raise exception 'Choose a valid order status';
  end if;
  select * into v_order from public.store_orders where id=p_order_id for update;
  if not found then return false; end if;
  if p_status=v_order.status then return true; end if;
  v_allowed := case v_order.status
    when 'new' then p_status in ('processing','packed','cancelled')
    when 'processing' then p_status in ('packed','cancelled')
    when 'packed' then p_status in ('shipped','cancelled')
    when 'shipped' then p_status in ('out_for_delivery','delivered')
    when 'out_for_delivery' then p_status='delivered'
    when 'delivered' then p_status='complete'
    else false
  end;
  if not v_allowed then raise exception 'That order status change is not allowed'; end if;
  if p_status='cancelled' then return public.cancel_store_order(p_order_id); end if;
  if p_status in ('shipped','out_for_delivery','delivered','complete') and v_order.payment_status not in ('paid','cod') then
    raise exception 'This order cannot ship until its payment is confirmed';
  end if;
  if p_status in ('shipped','out_for_delivery','delivered','complete') and v_order.refund_status in ('requested','approved') then
    raise exception 'Resolve the open refund request before shipping this order';
  end if;
  update public.store_orders set status=p_status,
    shipped_at=case when p_status='shipped' then coalesce(shipped_at,now()) else shipped_at end,
    delivered_at=case when p_status in ('delivered','complete') then coalesce(delivered_at,now()) else delivered_at end,
    updated_at=now()
  where id=p_order_id;
  return true;
end;
$$;

-- Record an admin refund review only after checking the current order state.
-- The store owner still sends the refund through Razorpay/bank first.
create or replace function public.review_store_order_refund(
  p_order_id uuid, p_refund_status text, p_admin_note text default null, p_confirm_refund boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_order public.store_orders%rowtype;
begin
  if p_refund_status not in ('none','requested','approved','rejected','processed') then raise exception 'Choose a valid refund status'; end if;
  if length(coalesce(p_admin_note,'')) > 1000 then raise exception 'Refund notes are too long'; end if;
  select * into v_order from public.store_orders where id=p_order_id for update;
  if not found then return false; end if;
  if p_refund_status=v_order.refund_status then return true; end if;
  if p_refund_status='requested' and v_order.refund_status not in ('none','rejected') then raise exception 'This refund request is already being reviewed'; end if;
  if p_refund_status in ('approved','rejected') and v_order.refund_status<>'requested' then raise exception 'Review the customer''s current refund request first'; end if;
  if p_refund_status='processed' then
    if not p_confirm_refund then raise exception 'Confirm that you sent the refund first'; end if;
    if v_order.refund_status not in ('requested','approved') then raise exception 'Approve or request a refund before marking it processed'; end if;
    if v_order.payment_status='paid' then null;
    elsif v_order.payment_status='cod' and v_order.status in ('delivered','complete') then null;
    else raise exception 'Only a captured prepaid order or delivered cash-on-delivery order can be marked refunded';
    end if;
  end if;
  update public.store_orders set
    refund_status=p_refund_status,
    refund_admin_note=nullif(trim(coalesce(p_admin_note,'')),''),
    refund_resolved_at=case when p_refund_status in ('approved','rejected','processed') then now() else null end,
    payment_status=case when p_refund_status='processed' and payment_status='paid' then 'refunded' else payment_status end,
    updated_at=now()
  where id=p_order_id;
  return true;
end;
$$;

-- Keep the four-argument order function for existing installations, then wrap
-- it so ownership is checked and stored before the API can return the order.
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

-- Keep any optional scheduled cleanup from releasing online inventory before
-- the API has reconciled its gateway payment.
create or replace function public.expire_checkout_orders()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order record; v_count integer:=0;
begin
  for v_order in select id from public.store_orders
    where payment_status='pending' and razorpay_order_id is null
      and created_at < now()-interval '45 minutes'
      and (razorpay_order_creation_token is null
           or razorpay_order_creating_at < now()-interval '2 minutes')
    for update skip locked loop
    if public.fail_checkout_order(v_order.id,null) then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end;
$$;

-- The four-argument helper is called only by the ownership-checking wrapper.
-- Revoke its default PUBLIC execute grant so shoppers cannot bypass ownership.
revoke all on function public.create_checkout_order(jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text) to service_role;
revoke all on function public.create_checkout_order(jsonb,jsonb,text,text,uuid) from public, anon, authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text,uuid) to service_role;
revoke all on function public.fail_checkout_order(uuid,text) from public, anon, authenticated;
grant execute on function public.fail_checkout_order(uuid,text) to service_role;
revoke all on function public.record_razorpay_capture(text,text,bigint,text,boolean,integer) from public, anon, authenticated;
grant execute on function public.record_razorpay_capture(text,text,bigint,text,boolean,integer) to service_role;
revoke all on function public.record_razorpay_capture(text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.record_razorpay_capture(text,text,bigint,text) to service_role;
revoke all on function public.claim_razorpay_order(uuid,text) from public, anon, authenticated;
grant execute on function public.claim_razorpay_order(uuid,text) to service_role;
revoke all on function public.cancel_store_order(uuid) from public, anon, authenticated;
grant execute on function public.cancel_store_order(uuid) to service_role;
revoke all on function public.update_store_order_status(uuid,text) from public, anon, authenticated;
grant execute on function public.update_store_order_status(uuid,text) to service_role;
revoke all on function public.review_store_order_refund(uuid,text,text,boolean) from public, anon, authenticated;
grant execute on function public.review_store_order_refund(uuid,text,text,boolean) to service_role;
revoke all on function public.consume_store_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_store_rate_limit(text,integer,integer) to service_role;
revoke all on function public.expire_checkout_orders() from public, anon, authenticated;
grant execute on function public.expire_checkout_orders() to service_role;
revoke update on public.store_orders from public, anon, authenticated;
grant select on public.store_orders to authenticated;
notify pgrst, 'reload schema';
