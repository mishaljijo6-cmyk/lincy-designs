-- Lincy Designs store schema. Run once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.store_products (
 id text primary key,
 name text not null,
 category text not null check (category in ('Churidars','Kurtas')),
 price integer not null check (price > 0),
 compare_at integer check (compare_at is null or compare_at = 0 or compare_at >= price),
 stock integer not null default 0 check (stock >= 0),
 badge text,
 image_url text not null,
 image_gallery text[] not null default '{}',
 color_images jsonb not null default '{}'::jsonb,
 sizes text[] not null default '{}',
 colors text[] not null default '{}',
 description text not null default '',
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.store_products drop constraint if exists store_products_category_check;
alter table public.store_products add constraint store_products_category_check check (category in ('Churidars','Kurtas'));

create table if not exists public.store_orders (
 id uuid primary key default gen_random_uuid(),
 user_id uuid references auth.users(id) on delete set null,
 order_number text unique not null,
 idempotency_key text unique,
 customer_name text not null,
 email text not null,
 customer_note text not null default '',
 phone text not null,
 address text not null,
 city text not null,
 state text not null,
 pincode text not null,
 subtotal integer not null check (subtotal >= 0),
 gst_amount integer not null default 0 check (gst_amount >= 0),
 shipping integer not null default 0 check (shipping >= 0),
 total integer not null check (total >= 0),
 payment_status text not null default 'pending' check (payment_status in ('pending','paid','failed','refunded','cod')),
 payment_provider text,
 razorpay_order_id text unique,
 payment_reference text,
 gateway_amount_paise bigint,
 status text not null default 'new' check (status in ('new','processing','packed','shipped','out_for_delivery','delivered','complete','cancelled')),
 shipping_carrier text,
 tracking_number text,
 tracking_url text,
 shipped_at timestamptz,
 delivered_at timestamptz,
 refund_status text not null default 'none' check (refund_status in ('none','requested','approved','rejected','processed')),
 refund_reason text,
 refund_requested_at timestamptz,
 refund_resolved_at timestamptz,
 refund_admin_note text,
 refund_reference text,
 refund_attempt_key text,
 refund_payment_reference text,
 refund_amount_paise bigint,
 stock_released_at timestamptz,
 cash_collected_at timestamptz,
 payment_reconciled_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.store_orders add column if not exists idempotency_key text;
alter table public.store_orders add column if not exists razorpay_order_id text;
alter table public.store_orders add column if not exists gst_amount integer not null default 0;
alter table public.store_orders add column if not exists updated_at timestamptz not null default now();
alter table public.store_orders add column if not exists customer_note text not null default '';
alter table public.store_orders add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.store_orders add column if not exists shipping_carrier text;
alter table public.store_orders add column if not exists tracking_number text;
alter table public.store_orders add column if not exists tracking_url text;
alter table public.store_orders add column if not exists shipped_at timestamptz;
alter table public.store_orders add column if not exists delivered_at timestamptz;
alter table public.store_orders add column if not exists refund_status text not null default 'none';
alter table public.store_orders add column if not exists refund_reason text;
alter table public.store_orders add column if not exists refund_requested_at timestamptz;
alter table public.store_orders add column if not exists refund_resolved_at timestamptz;
alter table public.store_orders add column if not exists refund_admin_note text;
alter table public.store_orders add column if not exists refund_reference text;
alter table public.store_orders add column if not exists refund_attempt_key text;
alter table public.store_orders add column if not exists refund_payment_reference text;
alter table public.store_orders add column if not exists refund_amount_paise bigint;
alter table public.store_orders add column if not exists stock_released_at timestamptz;
alter table public.store_orders add column if not exists cash_collected_at timestamptz;
alter table public.store_orders add column if not exists payment_reconciled_at timestamptz;
alter table public.store_orders add column if not exists gateway_amount_paise bigint;
create unique index if not exists store_orders_idempotency_key_uidx on public.store_orders(idempotency_key) where idempotency_key is not null;
create unique index if not exists store_orders_razorpay_order_id_uidx on public.store_orders(razorpay_order_id) where razorpay_order_id is not null;

create table if not exists public.store_order_items (
 id uuid primary key default gen_random_uuid(),
 order_id uuid not null references public.store_orders(id) on delete cascade,
 product_id text references public.store_products(id) on delete set null,
 product_name text not null,
 unit_price integer not null,
 quantity integer not null check (quantity > 0),
 gst_rate integer not null default 0,
 gst_amount integer not null default 0,
 selected_size text,
 selected_color text,
 image_url text
);
alter table public.store_order_items add column if not exists gst_rate integer not null default 0;
alter table public.store_order_items add column if not exists gst_amount integer not null default 0;

-- Optional per-size/color inventory. An empty variant table for a product means
-- its existing aggregate stock is shared across the selected options.
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

create table if not exists public.store_subscribers (
 email text primary key check (email = lower(email)),
 created_at timestamptz not null default now()
);

create index if not exists store_products_category_active_idx on public.store_products(category,active);
create index if not exists store_orders_created_status_idx on public.store_orders(created_at desc,status);
create index if not exists store_orders_payment_status_idx on public.store_orders(payment_status,created_at);
create index if not exists store_orders_user_created_idx on public.store_orders(user_id,created_at desc) where user_id is not null;
create index if not exists store_orders_refund_queue_idx on public.store_orders(refund_status,created_at desc) where refund_status <> 'none';
create index if not exists store_order_items_order_idx on public.store_order_items(order_id);

create or replace function public.touch_store_updated_at()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists store_products_updated_at on public.store_products;
create trigger store_products_updated_at before update on public.store_products
for each row execute function public.touch_store_updated_at();
drop trigger if exists store_orders_updated_at on public.store_orders;
create trigger store_orders_updated_at before update on public.store_orders
for each row execute function public.touch_store_updated_at();

create table if not exists public.newsletter_subscribers (
 id uuid primary key default gen_random_uuid(),
 email text not null unique check (length(email) between 5 and 254),
 created_at timestamptz not null default now()
);
alter table public.newsletter_subscribers enable row level security;

alter table public.store_products enable row level security;
alter table public.store_orders enable row level security;
alter table public.store_order_items enable row level security;
alter table public.store_subscribers enable row level security;
drop policy if exists "Anyone can view active products" on public.store_products;
drop policy if exists "Lincy admin manages products" on public.store_products;
drop policy if exists "Lincy admin reads orders" on public.store_orders;
drop policy if exists "Lincy admin updates orders" on public.store_orders;
drop policy if exists "Lincy admin reads order items" on public.store_order_items;
drop policy if exists "Customers read their own orders" on public.store_orders;
drop policy if exists "Customers read their own order items" on public.store_order_items;
create policy "Anyone can view active products" on public.store_products for select to anon,authenticated using (active = true);
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
-- Provision the existing confirmed owner account once; future checks use only
-- this server-controlled Supabase app-metadata role.
update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"store_role":"admin"}'::jsonb
 where lower(email) = 'mishalmj03@gmail.com'
   and email_confirmed_at is not null
   and raw_app_meta_data->>'store_role' is distinct from 'admin';

create policy "Lincy admin manages products" on public.store_products for all to authenticated
using (public.is_lincy_admin())
with check (public.is_lincy_admin());
create policy "Lincy admin reads orders" on public.store_orders for select to authenticated
using (public.is_lincy_admin());
create policy "Lincy admin reads order items" on public.store_order_items for select to authenticated
using (exists (select 1 from public.store_orders o where o.id = order_id and public.is_lincy_admin()));
create policy "Customers read their own orders" on public.store_orders for select to authenticated
using (user_id = auth.uid());
create policy "Customers read their own order items" on public.store_order_items for select to authenticated
using (exists (select 1 from public.store_orders o where o.id = order_id and o.user_id = auth.uid()));
drop policy if exists "Lincy admin reads subscribers" on public.store_subscribers;
create policy "Lincy admin reads subscribers" on public.store_subscribers for select to authenticated
using (public.is_lincy_admin());

grant select on public.store_products to anon, authenticated;
grant insert,update,delete on public.store_products to authenticated;
revoke update on public.store_orders from public,anon,authenticated;
grant select on public.store_orders to authenticated;
grant select on public.store_order_items, public.store_subscribers to authenticated;
grant all on public.store_products, public.store_orders, public.store_order_items, public.store_subscribers to service_role;

create or replace function public.cleanup_store_api_rate_limits()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_deleted integer;
begin
  delete from public.store_api_rate_limits where updated_at < now() - interval '90 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function public.cleanup_store_api_rate_limits() from public,anon,authenticated;
grant execute on function public.cleanup_store_api_rate_limits() to service_role;

-- Checkout is called only by the private Vercel API using the Supabase service role.
create or replace function public.create_checkout_order(p_customer jsonb, p_items jsonb, p_provider text, p_idempotency_key text, p_user_id uuid)
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
  v_pending_id uuid;
  v_number text;
  v_line record;
  v_customer_name text := trim(coalesce(p_customer->>'name',''));
  v_email text := lower(trim(coalesce(p_customer->>'email','')));
  v_phone text := trim(coalesce(p_customer->>'phone',''));
  v_customer_note text := trim(coalesce(p_customer->>'note',''));
begin
  if p_provider not in ('razorpay','cod') then raise exception 'Invalid payment method'; end if;
  if p_user_id is null then raise exception 'A signed-in customer is required'; end if;
  -- Serialize checkout creation by account so two tabs with different
  -- idempotency keys cannot reserve two orders at the same time.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
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
      if v_order.user_id is not null and v_order.user_id <> p_user_id then raise exception 'This checkout belongs to another account'; end if;
      if v_order.payment_status = 'failed' then
        if v_order.payment_provider is distinct from p_provider then raise exception 'An expired order must be retried with its original payment method'; end if;
        for v_line in select product_id,quantity from public.store_order_items where order_id=v_order.id and product_id is not null order by product_id loop
          select * into v_product from public.store_products where id=v_line.product_id and active=true for update;
          if not found or v_product.stock < v_line.quantity then raise exception 'A selected product is no longer available in the requested quantity'; end if;
          update public.store_products set stock=stock-v_line.quantity where id=v_product.id;
        end loop;
        update public.store_orders set payment_status=case when p_provider='cod' then 'cod' else 'pending' end,
          payment_provider=p_provider,razorpay_order_id=case when p_provider='razorpay' then v_order.razorpay_order_id else null end,payment_reference=null,user_id=p_user_id where id=v_order.id;
        select * into v_order from public.store_orders where id=v_order.id;
      end if;
      if v_order.payment_status = 'pending' then
        update public.store_orders set customer_note=v_customer_note where id=v_order.id;
        select * into v_order from public.store_orders where id=v_order.id;
      end if;
      return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider,'razorpay_order_id',v_order.razorpay_order_id);
    end if;
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

  -- Lock rows in a stable order and reserve inventory in this transaction.
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 10 then raise exception 'Invalid quantity'; end if;
    select * into v_product from public.store_products where id = v_item->>'productId' and active = true for update;
    if not found then raise exception 'A selected product is unavailable'; end if;
    if v_product.stock < v_qty then raise exception 'Insufficient stock for %', v_product.name; end if;
    if lower(trim(coalesce(v_item->>'size',''))) not in ('','one size') and not (trim(v_item->>'size') = any(v_product.sizes)) then raise exception 'Invalid size'; end if;
    if coalesce(v_item->>'color','') <> '' and not (v_item->>'color' = any(v_product.colors)) then raise exception 'Invalid color'; end if;
    update public.store_products set stock = stock - v_qty where id = v_product.id;
    v_subtotal := v_subtotal + v_product.price * v_qty;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    v_gst_amount := v_gst_amount + round((v_product.price::numeric * v_qty * v_tax_rate) / (100 + v_tax_rate))::integer;
    v_count := v_count + 1;
  end loop;
  if v_count <> jsonb_array_length(p_items) then raise exception 'Invalid product list'; end if;
  v_shipping := 99;
  v_number := 'LD-' || to_char(now(),'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.store_orders(user_id,order_number,idempotency_key,customer_name,email,customer_note,phone,address,city,state,pincode,subtotal,gst_amount,shipping,total,payment_status,payment_provider)
  values(p_user_id,v_number,p_idempotency_key,v_customer_name,v_email,v_customer_note,v_phone,trim(p_customer->>'address'),trim(p_customer->>'city'),trim(p_customer->>'state'),trim(p_customer->>'pincode'),v_subtotal,v_gst_amount,v_shipping,v_subtotal+v_shipping,case when p_provider='cod' then 'cod' else 'pending' end,p_provider)
  returning id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.store_products where id = v_item->>'productId';
    v_qty := (v_item->>'quantity')::integer;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    insert into public.store_order_items(order_id,product_id,product_name,unit_price,quantity,gst_rate,gst_amount,selected_size,selected_color,image_url)
    values(v_order_id,v_product.id,v_product.name,v_product.price,v_qty,v_tax_rate,round((v_product.price::numeric * v_qty * v_tax_rate) / (100 + v_tax_rate))::integer,nullif(case when lower(trim(coalesce(v_item->>'size','')))='one size' then '' else trim(coalesce(v_item->>'size','')) end,''),nullif(v_item->>'color',''),v_product.image_url);
  end loop;
  select * into v_order from public.store_orders where id=v_order_id;
  return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider);
end;
$$;

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

create or replace function public.expire_checkout_orders()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order record; v_line record; v_count integer:=0;
begin
  for v_order in select id from public.store_orders where payment_status='pending' and razorpay_order_id is null and created_at < now()-interval '45 minutes' for update skip locked loop
    update public.store_orders set payment_status='failed', stock_released_at=now() where id=v_order.id;
    for v_line in select product_id,quantity from public.store_order_items where order_id=v_order.id and product_id is not null loop
      update public.store_products set stock=stock+v_line.quantity where id=v_line.product_id;
    end loop;
    v_count:=v_count+1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.create_checkout_order(jsonb,jsonb,text,text,uuid) from public,anon,authenticated;
revoke all on function public.fail_checkout_order(uuid,text) from public,anon,authenticated;
revoke all on function public.expire_checkout_orders() from public,anon,authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text,uuid) to service_role;
grant execute on function public.fail_checkout_order(uuid,text) to service_role;
grant execute on function public.expire_checkout_orders() to service_role;

-- Starter catalog. Replace these demo items/photos with real inventory in /admin.html.
insert into public.store_products(id,name,category,price,compare_at,stock,badge,image_url,sizes,colors,description,active)
values
('tt-001','Garden Bloom Anarkali Churidar Set','Churidars',3290,3890,7,'NEW ARRIVAL','https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL','XXL'],array['Sage','Rose'],'A softly flared Anarkali set in a botanical print, with an easy drape and thoughtful finishing. Includes kurta, churidar bottom and dupatta.',true),
('tt-002','Ivory Festive Churidar Suit','Churidars',3490,3990,8,'FESTIVE EDIT','https://images.unsplash.com/photo-1610030469983-98e550d6193c?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL','XXL'],array['Ivory','Gold'],'A graceful festive suit with delicate woven-look details, a comfortable churidar bottom and a coordinating dupatta.',true),
('tt-003','Mullapoo Embroidered Kurta','Kurtas',1890,2290,18,'BESTSELLER','https://images.unsplash.com/photo-1597983073493-88cd35cf93b0?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL','XXL'],array['Blush','Ivory'],'A delicate floral kurta with gentle embroidery and a relaxed fit. An easy favourite for workdays and family visits.',true),
('tt-004','Soft Sage Straight-Cut Churidar Set','Churidars',2790,0,5,'LIMITED EDITION','https://images.unsplash.com/photo-1617627143750-d86bc21e42bb?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL'],array['Sage','Cream'],'A versatile straight-cut kurta paired with a matching churidar and a light dupatta for effortless all-day comfort.',true),
('tt-005','Rose Print Everyday Kurta','Kurtas',1490,1790,22,'EASY COTTON','https://images.unsplash.com/photo-1585487000160-6ebcfceb0d03?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL','XXL'],array['Terracotta','Indigo'],'Soft breathable cotton, a beautiful print, and an easy everyday fit. Made for comfort from morning chai to evening plans.',true),
('tt-006','Maroon Embroidered Churidar Set','Churidars',3990,4490,4,'FEW LEFT','https://images.unsplash.com/photo-1610030469983-98e550d6193c?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL','XXL'],array['Maroon','Gold'],'A rich occasion-ready set with graceful embroidery, a flattering kurta, comfortable churidar and a coordinating dupatta.',true),
('tt-007','Everyday Straight Kurta','Kurtas',1290,1590,15,'EVERYDAY FAVOURITE','https://images.unsplash.com/photo-1598554747436-c9293d6a588f?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL','XXL'],array['Ivory','Sage'],'A simple, easy-to-style kurta with a relaxed silhouette and soft feel for everyday wear.',true),
('tt-008','Textured Cotton Kurta','Kurtas',2190,0,9,'SMALL BATCH','https://images.unsplash.com/photo-1598554747436-c9293d6a588f?auto=format&fit=crop&w=900&q=82',array['S','M','L','XL'],array['Ivory','Forest'],'A crisp cotton-blend kurta with understated texture and a relaxed silhouette, finished for comfort.',true)
on conflict(id) do update set name=excluded.name,category=excluded.category,price=excluded.price,compare_at=excluded.compare_at,badge=excluded.badge,image_url=excluded.image_url,sizes=excluded.sizes,colors=excluded.colors,description=excluded.description,active=excluded.active;
