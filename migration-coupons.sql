-- Run this in the Supabase SQL Editor after migration-orders-and-checkout.sql.
-- Adds private coupon management and atomic coupon redemption to checkout.

create table if not exists public.store_coupons (
  code text primary key check (code ~ '^[A-Z0-9_-]{3,24}$'),
  discount_type text not null check (discount_type in ('percent','fixed')),
  discount_value integer not null check (discount_value > 0),
  min_subtotal integer not null default 0 check (min_subtotal >= 0),
  max_discount integer check (max_discount is null or max_discount > 0),
  usage_limit integer check (usage_limit is null or usage_limit > 0),
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
  add column if not exists discount_amount integer not null default 0;
alter table public.store_orders drop constraint if exists store_orders_discount_amount_check;
alter table public.store_orders add constraint store_orders_discount_amount_check
  check (discount_amount >= 0 and discount_amount <= subtotal);

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
    select * into v_existing from public.store_orders where id = v_order_id;
    return jsonb_build_object(
      'id', v_existing.id,
      'order_number', v_existing.order_number,
      'subtotal', v_existing.subtotal,
      'gst_amount', v_existing.gst_amount,
      'shipping', v_existing.shipping,
      'discount_amount', v_existing.discount_amount,
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

    if v_coupon.discount_type = 'percent' then
      v_raw_discount := round((v_order->>'subtotal')::numeric * v_coupon.discount_value / 100)::integer;
    else
      v_raw_discount := v_coupon.discount_value;
    end if;
    v_discount := least(
      (v_order->>'subtotal')::integer,
      v_raw_discount,
      coalesce(v_coupon.max_discount, (v_order->>'subtotal')::integer)
    );

    update public.store_coupons
       set usage_count = usage_count + 1, updated_at = now()
     where code = v_code
       and active
       and (usage_limit is null or usage_count < usage_limit);
    if not found then raise exception 'This coupon has reached its use limit'; end if;
    update public.store_orders
       set coupon_code = v_code,
           discount_amount = v_discount,
           total = total - v_discount
     where id = v_order_id;
  end if;

  select * into v_existing from public.store_orders where id = v_order_id;
  return jsonb_build_object(
    'id', v_existing.id,
    'order_number', v_existing.order_number,
    'subtotal', v_existing.subtotal,
    'gst_amount', v_existing.gst_amount,
    'shipping', v_existing.shipping,
    'discount_amount', v_existing.discount_amount,
    'coupon_code', v_existing.coupon_code,
    'total', v_existing.total,
    'payment_status', v_existing.payment_status,
    'payment_provider', v_existing.payment_provider,
    'razorpay_order_id', v_existing.razorpay_order_id
  );
end;
$$;

revoke all on function public.create_checkout_order(jsonb,jsonb,text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text,uuid,text) to service_role;

notify pgrst, 'reload schema';
