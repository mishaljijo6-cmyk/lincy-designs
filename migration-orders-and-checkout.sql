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
  add column if not exists shipping_carrier text,
  add column if not exists tracking_number text,
  add column if not exists tracking_url text,
  add column if not exists shipped_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists refund_status text not null default 'none',
  add column if not exists refund_reason text,
  add column if not exists refund_requested_at timestamptz,
  add column if not exists refund_resolved_at timestamptz,
  add column if not exists refund_admin_note text;

-- Product photos can be uploaded from the admin device. Only the store owner
-- can write files; shoppers can read the public product images.
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
    bucket_id = 'store-product-images' and lower(auth.jwt() ->> 'email') = 'mishalmj03@gmail.com'
  );
drop policy if exists "Store owner updates product images" on storage.objects;
create policy "Store owner updates product images" on storage.objects
  for update to authenticated using (
    bucket_id = 'store-product-images' and lower(auth.jwt() ->> 'email') = 'mishalmj03@gmail.com'
  ) with check (
    bucket_id = 'store-product-images' and lower(auth.jwt() ->> 'email') = 'mishalmj03@gmail.com'
  );
drop policy if exists "Store owner deletes product images" on storage.objects;
create policy "Store owner deletes product images" on storage.objects
  for delete to authenticated using (
    bucket_id = 'store-product-images' and lower(auth.jwt() ->> 'email') = 'mishalmj03@gmail.com'
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
create policy "Customers read their own orders" on public.store_orders for select to authenticated
using (user_id = auth.uid());
drop policy if exists "Customers read their own order items" on public.store_order_items;
create policy "Customers read their own order items" on public.store_order_items for select to authenticated
using (exists (
  select 1 from public.store_orders o
  where o.id = order_id and o.user_id = auth.uid()
));
grant select on public.store_orders, public.store_order_items to authenticated;
grant update on public.store_orders to authenticated;
grant all on public.store_orders, public.store_order_items to service_role;

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
begin
  if p_provider not in ('razorpay','cod') then raise exception 'Invalid payment method'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 20 then raise exception 'Invalid items'; end if;
  if length(v_customer_name) not between 2 and 100 or v_email !~* '^[^@ ]+@[^@ ]+\.[^@ ]+$' or v_phone !~ '^[0-9+() -]{10,20}$' then raise exception 'Invalid customer details'; end if;
  if length(trim(coalesce(p_customer->>'address',''))) not between 4 and 300
    or length(trim(coalesce(p_customer->>'city',''))) not between 2 and 100
    or length(trim(coalesce(p_customer->>'state',''))) not between 2 and 100
    or trim(coalesce(p_customer->>'pincode','')) !~ '^[0-9]{6}$' then raise exception 'Invalid delivery address'; end if;

  if p_idempotency_key is not null then
    select * into v_order from public.store_orders where idempotency_key = p_idempotency_key for update;
    if found then
      if v_order.payment_status = 'failed' then
        for v_line in select product_id,quantity from public.store_order_items where order_id=v_order.id and product_id is not null order by product_id loop
          select * into v_product from public.store_products where id=v_line.product_id and active=true for update;
          if not found or v_product.stock < v_line.quantity then raise exception 'A selected product is no longer available in the requested quantity'; end if;
          update public.store_products set stock=stock-v_line.quantity where id=v_product.id;
        end loop;
        update public.store_orders set payment_status=case when p_provider='cod' then 'cod' else 'pending' end,
          payment_provider=p_provider,razorpay_order_id=null,payment_reference=null where id=v_order.id;
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
    if coalesce(v_item->>'size','') <> '' and not (v_item->>'size' = any(v_product.sizes)) then raise exception 'Invalid size'; end if;
    if coalesce(v_item->>'color','') <> '' and not (v_item->>'color' = any(v_product.colors)) then raise exception 'Invalid color'; end if;
    update public.store_products set stock=stock-v_qty where id=v_product.id;
    v_subtotal := v_subtotal + v_product.price * v_qty;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    v_gst_amount := v_gst_amount + round((v_product.price::numeric*v_qty*v_tax_rate)/(100+v_tax_rate))::integer;
    v_count := v_count + 1;
  end loop;
  if v_count <> jsonb_array_length(p_items) then raise exception 'Invalid product list'; end if;
  v_shipping := case when v_subtotal >= 2499 then 0 else 99 end;
  v_number := 'LD-'||to_char(now(),'YYMMDD')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.store_orders(order_number,idempotency_key,customer_name,email,phone,address,city,state,pincode,subtotal,gst_amount,shipping,total,payment_status,payment_provider)
  values(v_number,p_idempotency_key,v_customer_name,v_email,v_phone,trim(p_customer->>'address'),trim(p_customer->>'city'),trim(p_customer->>'state'),trim(p_customer->>'pincode'),v_subtotal,v_gst_amount,v_shipping,v_subtotal+v_shipping,case when p_provider='cod' then 'cod' else 'pending' end,p_provider)
  returning id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.store_products where id=v_item->>'productId';
    v_qty := (v_item->>'quantity')::integer;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    insert into public.store_order_items(order_id,product_id,product_name,unit_price,quantity,gst_rate,gst_amount,selected_size,selected_color,image_url)
    values(v_order_id,v_product.id,v_product.name,v_product.price,v_qty,v_tax_rate,round((v_product.price::numeric*v_qty*v_tax_rate)/(100+v_tax_rate))::integer,nullif(v_item->>'size',''),nullif(v_item->>'color',''),v_product.image_url);
  end loop;
  select * into v_order from public.store_orders where id=v_order_id;
  return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider);
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
begin
  if p_user_id is null then raise exception 'A signed-in customer is required'; end if;

  select user_id into v_existing_user
    from public.store_orders
    where idempotency_key = p_idempotency_key
    for update;
  if found and (v_existing_user is null or v_existing_user <> p_user_id) then
    raise exception 'This checkout belongs to another account';
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
declare v_order record; v_line record; v_count integer:=0;
begin
  for v_order in select id from public.store_orders
    where payment_status='pending' and razorpay_order_id is null
      and created_at < now()-interval '45 minutes'
    for update skip locked loop
    update public.store_orders set payment_status='failed' where id=v_order.id;
    for v_line in select product_id,quantity from public.store_order_items where order_id=v_order.id and product_id is not null loop
      update public.store_products set stock=stock+v_line.quantity where id=v_line.product_id;
    end loop;
    v_count:=v_count+1;
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
notify pgrst, 'reload schema';
