-- Run this in the Supabase SQL Editor after migration-orders-and-checkout.sql.
-- Adds private coupon management and atomic coupon redemption to checkout.

create table if not exists public.store_coupons (
  code text primary key check (code ~ '^[A-Z0-9_-]{3,24}$'),
  discount_type text not null check (discount_type in ('percent','fixed','free_delivery')),
  discount_value integer not null check ((discount_type = 'free_delivery' and discount_value = 0) or (discount_type <> 'free_delivery' and discount_value > 0)),
  min_subtotal integer not null default 0 check (min_subtotal >= 0),
  max_discount integer check (max_discount is null or max_discount > 0),
  usage_limit integer check (usage_limit is null or usage_limit > 0),
  per_user_limit integer check (per_user_limit is null or per_user_limit > 0),
  usage_count integer not null default 0 check (usage_count >= 0),
  starts_at timestamptz,
  expires_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_coupons_date_order_check check (expires_at is null or starts_at is null or expires_at > starts_at)
);

alter table public.store_orders
  add column if not exists coupon_code text,
  add column if not exists discount_amount integer not null default 0,
  add column if not exists delivery_discount integer not null default 0;
alter table public.store_orders drop constraint if exists store_orders_discount_amount_check;
alter table public.store_orders add constraint store_orders_discount_amount_check
  check (discount_amount >= 0 and discount_amount <= subtotal);
alter table public.store_orders drop constraint if exists store_orders_delivery_discount_check;
alter table public.store_orders add constraint store_orders_delivery_discount_check
  check (delivery_discount >= 0 and delivery_discount <= shipping);

-- Upgrade coupon constraints safely on stores where the earlier coupon
-- migration already created the table with only percent/fixed coupons.
alter table public.store_coupons drop constraint if exists store_coupons_discount_type_check;
alter table public.store_coupons drop constraint if exists store_coupons_discount_value_check;
alter table public.store_coupons add constraint store_coupons_discount_type_check
  check (discount_type in ('percent','fixed','free_delivery'));
alter table public.store_coupons add constraint store_coupons_discount_value_check
  check ((discount_type = 'free_delivery' and discount_value = 0) or (discount_type <> 'free_delivery' and discount_value > 0));
alter table public.store_coupons add column if not exists per_user_limit integer;
alter table public.store_coupons drop constraint if exists store_coupons_per_user_limit_check;
alter table public.store_coupons add constraint store_coupons_per_user_limit_check
  check (per_user_limit is null or per_user_limit > 0);

create table if not exists public.store_coupon_redemptions (
  order_id uuid primary key references public.store_orders(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  code text not null references public.store_coupons(code),
  status text not null default 'reserved' check (status in ('reserved','redeemed','released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.store_coupon_redemptions alter column user_id drop not null;
alter table public.store_coupon_redemptions drop constraint if exists store_coupon_redemptions_user_id_fkey;
alter table public.store_coupon_redemptions add constraint store_coupon_redemptions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- Rebuild the reservation ledger from historical orders so coupons used before
-- this migration do not retain stale counts from failed or abandoned attempts.
insert into public.store_coupon_redemptions(order_id, user_id, code, status, created_at, updated_at)
select o.id, o.user_id, upper(trim(o.coupon_code)),
       case
         when o.status = 'cancelled' then 'released'
         when o.payment_status = 'pending' then 'reserved'
         when o.payment_status in ('paid','refunded','cod') then 'redeemed'
         else 'released'
       end,
       o.created_at, coalesce(o.updated_at, o.created_at)
  from public.store_orders o
 where o.coupon_code is not null
   and exists (select 1 from public.store_coupons c where c.code = upper(trim(o.coupon_code)))
on conflict (order_id) do update set
  user_id = excluded.user_id,
  code = excluded.code,
  status = excluded.status,
  updated_at = excluded.updated_at;

update public.store_coupons c
   set usage_count = (
     select count(*)::integer from public.store_coupon_redemptions r
      where r.code = c.code and r.status in ('reserved','redeemed')
   ),
       updated_at = now();

create index if not exists store_coupon_redemptions_user_idx
  on public.store_coupon_redemptions(code, user_id, status);
alter table public.store_coupon_redemptions enable row level security;
revoke all on public.store_coupon_redemptions from public, anon, authenticated;
grant all on public.store_coupon_redemptions to service_role;

create or replace function public.reserve_coupon_redemption(p_order_id uuid, p_user_id uuid, p_code text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare
  v_coupon public.store_coupons%rowtype;
  v_status text;
  v_user_uses integer;
begin
  if p_user_id is null then raise exception 'A signed-in customer is required'; end if;
  select * into v_coupon from public.store_coupons where code = p_code for update;
  if not found or not v_coupon.active then raise exception 'This coupon is invalid or inactive'; end if;
  if v_coupon.starts_at is not null and v_coupon.starts_at > now() then raise exception 'This coupon is not active yet'; end if;
  if v_coupon.expires_at is not null and v_coupon.expires_at <= now() then raise exception 'This coupon has expired'; end if;

  select status into v_status from public.store_coupon_redemptions where order_id = p_order_id for update;
  if v_status in ('reserved','redeemed') then return true; end if;

  if v_coupon.per_user_limit is not null then
    select count(*) into v_user_uses from public.store_coupon_redemptions
     where code = p_code and user_id = p_user_id and order_id <> p_order_id
       and status in ('reserved','redeemed');
    if v_user_uses >= v_coupon.per_user_limit then raise exception 'This coupon has reached its per-customer use limit'; end if;
  end if;
  if v_coupon.usage_limit is not null and v_coupon.usage_count >= v_coupon.usage_limit then
    raise exception 'This coupon has reached its use limit';
  end if;

  update public.store_coupons set usage_count = usage_count + 1, updated_at = now() where code = p_code;
  insert into public.store_coupon_redemptions(order_id,user_id,code,status,updated_at)
  values(p_order_id,p_user_id,p_code,'reserved',now())
  on conflict (order_id) do update
     set user_id = excluded.user_id, code = excluded.code, status = 'reserved', updated_at = now()
   where public.store_coupon_redemptions.status = 'released';
  return true;
end;
$$;

create or replace function public.complete_coupon_redemption(p_order_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.store_coupon_redemptions set status = 'redeemed', updated_at = now()
   where order_id = p_order_id and status = 'reserved';
  return found;
end;
$$;

create or replace function public.release_coupon_redemption(p_order_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_code text;
begin
  update public.store_coupon_redemptions set status = 'released', updated_at = now()
   where order_id = p_order_id and status in ('reserved','redeemed')
   returning code into v_code;
  if v_code is null then return false; end if;
  update public.store_coupons set usage_count = greatest(0, usage_count - 1), updated_at = now() where code = v_code;
  return true;
end;
$$;

create or replace function public.complete_free_checkout_order(p_order_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.store_orders%rowtype;
begin
  select * into v_order from public.store_orders where id=p_order_id for update;
  if not found or v_order.user_id is distinct from p_user_id or v_order.total <> 0 then return false; end if;
  if v_order.payment_status='paid' and v_order.payment_provider='coupon'
     and v_order.payment_reference='no-payment-required' then return true; end if;
  if v_order.payment_status <> 'pending' then return false; end if;
  update public.store_orders set payment_status='paid',payment_provider='coupon',
    payment_reference='no-payment-required',updated_at=now() where id=v_order.id;
  perform public.complete_coupon_redemption(v_order.id);
  return true;
end;
$$;

-- Give the owner a safe, paused starter code to configure from the admin page.
insert into public.store_coupons(code, discount_type, discount_value, active)
values ('FREESHIP', 'free_delivery', 0, false)
on conflict (code) do nothing;

alter table public.store_coupons enable row level security;
revoke all on public.store_coupons from public, anon, authenticated;
grant all on public.store_coupons to service_role;

create or replace function public.create_checkout_order(
  p_customer jsonb,
  p_items jsonb,
  p_provider text,
  p_idempotency_key text,
  p_user_id uuid,
  p_coupon_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := nullif(upper(trim(coalesce(p_coupon_code, ''))), '');
  v_coupon public.store_coupons%rowtype;
  v_existing public.store_orders%rowtype;
  v_order jsonb;
  v_order_id uuid;
  v_discount integer := 0;
  v_delivery_discount integer := 0;
  v_raw_discount integer;
begin
  if p_user_id is null then raise exception 'A signed-in customer is required'; end if;

  select * into v_existing
    from public.store_orders
   where idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing.user_id is null or v_existing.user_id <> p_user_id then
      raise exception 'This checkout belongs to another account';
    end if;
    if coalesce(v_existing.coupon_code, '') <> coalesce(v_code, '') then
      raise exception 'The coupon changed after this checkout started. Start checkout again.';
    end if;
    v_order := public.create_checkout_order(p_customer, p_items, p_provider, p_idempotency_key, p_user_id);
    v_order_id := nullif(v_order->>'id', '')::uuid;
    if v_existing.payment_status = 'failed' and v_code is not null then
      perform public.reserve_coupon_redemption(v_order_id, p_user_id, v_code);
      if v_order->>'payment_status' = 'cod' then
        perform public.complete_coupon_redemption(v_order_id);
      end if;
    end if;
    select * into v_existing from public.store_orders where id = v_order_id;
    return jsonb_build_object(
      'id', v_existing.id,
      'order_number', v_existing.order_number,
      'subtotal', v_existing.subtotal,
      'gst_amount', v_existing.gst_amount,
      'shipping', v_existing.shipping,
      'discount_amount', v_existing.discount_amount,
      'delivery_discount', v_existing.delivery_discount,
      'coupon_code', v_existing.coupon_code,
      'total', v_existing.total,
      'payment_status', v_existing.payment_status,
      'payment_provider', v_existing.payment_provider,
      'razorpay_order_id', v_existing.razorpay_order_id
    );
  end if;

  -- The existing protected routine creates the order and reserves stock. Any
  -- coupon validation failure below rolls this whole transaction back.
  v_order := public.create_checkout_order(p_customer, p_items, p_provider, p_idempotency_key, p_user_id);
  v_order_id := nullif(v_order->>'id', '')::uuid;
  if v_order_id is null then raise exception 'Checkout did not return an order id'; end if;

  if v_code is not null then
    select * into v_coupon from public.store_coupons where code = v_code for update;
    if not found or not v_coupon.active then raise exception 'This coupon is invalid or inactive'; end if;
    if v_coupon.starts_at is not null and v_coupon.starts_at > now() then raise exception 'This coupon is not active yet'; end if;
    if v_coupon.expires_at is not null and v_coupon.expires_at <= now() then raise exception 'This coupon has expired'; end if;
    if v_coupon.usage_limit is not null and v_coupon.usage_count >= v_coupon.usage_limit then raise exception 'This coupon has reached its use limit'; end if;
    if (v_order->>'subtotal')::integer < v_coupon.min_subtotal then raise exception 'This coupon does not meet the minimum subtotal'; end if;

    if v_coupon.discount_type = 'free_delivery' then
      v_delivery_discount := (v_order->>'shipping')::integer;
      if v_delivery_discount <= 0 then raise exception 'Free delivery is available only with an eligible free-delivery coupon'; end if;
      v_discount := 0;
    elsif v_coupon.discount_type = 'percent' then
      v_raw_discount := round((v_order->>'subtotal')::numeric * v_coupon.discount_value / 100)::integer;
      v_discount := least(
        (v_order->>'subtotal')::integer,
        v_raw_discount,
        coalesce(v_coupon.max_discount, (v_order->>'subtotal')::integer)
      );
    else
      v_raw_discount := v_coupon.discount_value;
      v_discount := least(
        (v_order->>'subtotal')::integer,
        v_raw_discount,
        coalesce(v_coupon.max_discount, (v_order->>'subtotal')::integer)
      );
    end if;

    -- Allocate the item discount proportionally before recalculating included
    -- GST. This stable ordering matches lib/coupons.js integer apportionment.
    if v_discount > 0 then
      with line_values as (
        select id, product_id, selected_size, selected_color,
               (unit_price::bigint * quantity::bigint) as gross,
               floor((unit_price::numeric * quantity * v_discount) / nullif((v_order->>'subtotal')::integer,0))::bigint as base_discount,
               mod((unit_price::numeric * quantity * v_discount), nullif((v_order->>'subtotal')::integer,0)) as remainder
          from public.store_order_items
         where order_id=v_order_id
      ), ranked as (
        select *, row_number() over (
                 order by remainder desc, product_id collate "C",
                          coalesce(selected_size, '') collate "C",
                          coalesce(selected_color, '') collate "C", gross desc, id
               ) as remainder_rank,
               v_discount - sum(base_discount) over () as remainder_count
          from line_values
      ), allocations as (
        select id, gross, base_discount + case when remainder_rank <= remainder_count then 1 else 0 end as discount
          from ranked
      )
      update public.store_order_items i
         set gst_amount=round(((a.gross-a.discount)::numeric * i.gst_rate) / (100+i.gst_rate))::integer
        from allocations a
       where i.id=a.id;
    end if;

    update public.store_orders
       set coupon_code = v_code,
           discount_amount = v_discount,
           delivery_discount = v_delivery_discount,
           gst_amount = (select coalesce(sum(gst_amount),0) from public.store_order_items where order_id=v_order_id),
           total = total - v_discount - v_delivery_discount
     where id = v_order_id;
    perform public.reserve_coupon_redemption(v_order_id, p_user_id, v_code);
    if v_order->>'payment_status' = 'cod' then
      perform public.complete_coupon_redemption(v_order_id);
    end if;
  end if;

  select * into v_existing from public.store_orders where id = v_order_id;
  return jsonb_build_object(
    'id', v_existing.id,
    'order_number', v_existing.order_number,
    'subtotal', v_existing.subtotal,
    'gst_amount', v_existing.gst_amount,
    'shipping', v_existing.shipping,
    'discount_amount', v_existing.discount_amount,
    'delivery_discount', v_existing.delivery_discount,
    'coupon_code', v_existing.coupon_code,
    'total', v_existing.total,
    'payment_status', v_existing.payment_status,
    'payment_provider', v_existing.payment_provider,
    'razorpay_order_id', v_existing.razorpay_order_id
  );
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

create or replace function public.cancel_store_order(p_order_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order public.store_orders%rowtype; v_line record;
begin
  select * into v_order from public.store_orders where id=p_order_id for update;
  if not found then return false; end if;
  if v_order.status='cancelled' then return true; end if;
  if v_order.status in ('shipped','out_for_delivery','delivered','complete') then
    raise exception 'Orders already handed to the carrier cannot be cancelled here';
  end if;
  if v_order.payment_status='pending' then raise exception 'Check the Razorpay payment before cancelling this order'; end if;
  update public.store_orders set status='cancelled',updated_at=now(),
    refund_status=case when payment_status='paid' then 'requested' else refund_status end,
    refund_reason=case when payment_status='paid' then 'Order cancelled by the store owner.' else refund_reason end,
    refund_requested_at=case when payment_status='paid' then now() else refund_requested_at end,
    refund_admin_note=case when payment_status='paid' then 'Payment was already captured. Initiate the refund in Razorpay and then save its final status.' else refund_admin_note end
   where id=v_order.id;
  if v_order.payment_status in ('paid','cod') then
    for v_line in select product_id,quantity from public.store_order_items where order_id=v_order.id and product_id is not null loop
      update public.store_products set stock=stock+v_line.quantity where id=v_line.product_id;
    end loop;
  end if;
  perform public.release_coupon_redemption(v_order.id);
  return true;
end;
$$;

revoke all on function public.create_checkout_order(jsonb,jsonb,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text,uuid,text) to service_role;
revoke all on function public.reserve_coupon_redemption(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.complete_coupon_redemption(uuid) from public, anon, authenticated;
revoke all on function public.release_coupon_redemption(uuid) from public, anon, authenticated;
revoke all on function public.complete_free_checkout_order(uuid,uuid) from public, anon, authenticated;
revoke all on function public.cancel_store_order(uuid) from public, anon, authenticated;
grant execute on function public.reserve_coupon_redemption(uuid,uuid,text) to service_role;
grant execute on function public.complete_coupon_redemption(uuid) to service_role;
grant execute on function public.release_coupon_redemption(uuid) to service_role;
grant execute on function public.complete_free_checkout_order(uuid,uuid) to service_role;
grant execute on function public.cancel_store_order(uuid) to service_role;

notify pgrst, 'reload schema';
