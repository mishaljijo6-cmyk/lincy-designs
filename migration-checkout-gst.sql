-- Run once in the Supabase SQL Editor after the base store schema.
-- Persists the GST amount shown to the buyer and the tax rate/amount per order line.
alter table public.store_orders
  add column if not exists gst_amount integer not null default 0;
alter table public.store_order_items
  add column if not exists gst_rate integer not null default 0,
  add column if not exists gst_amount integer not null default 0;

create or replace function public.create_checkout_order(p_customer jsonb, p_items jsonb, p_provider text, p_idempotency_key text)
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
  v_expired record;
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

  -- Release stock held by abandoned payment attempts before reserving new items.
  for v_expired in select id from public.store_orders where payment_status='pending' and created_at < now()-interval '45 minutes' for update skip locked loop
    update public.store_orders set payment_status='failed' where id=v_expired.id;
    for v_line in select product_id,quantity from public.store_order_items where order_id=v_expired.id and product_id is not null loop
      update public.store_products set stock=stock+v_line.quantity where id=v_line.product_id;
    end loop;
  end loop;

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
      elsif v_order.payment_status = 'pending' and v_order.payment_provider is distinct from p_provider then
        raise exception 'This checkout already has a pending order using another payment method';
      end if;
      return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider,'razorpay_order_id',v_order.razorpay_order_id);
    end if;
  end if;

  -- Lock rows in a stable order and reserve inventory in this transaction.
  for v_item in select value from jsonb_array_elements(p_items) order by value->>'productId' loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty < 1 or v_qty > 10 then raise exception 'Invalid quantity'; end if;
    select * into v_product from public.store_products where id = v_item->>'productId' and active = true for update;
    if not found then raise exception 'A selected product is unavailable'; end if;
    if v_product.stock < v_qty then raise exception 'Insufficient stock for %', v_product.name; end if;
    if coalesce(v_item->>'size','') <> '' and not (v_item->>'size' = any(v_product.sizes)) then raise exception 'Invalid size'; end if;
    if coalesce(v_item->>'color','') <> '' and not (v_item->>'color' = any(v_product.colors)) then raise exception 'Invalid color'; end if;
    update public.store_products set stock = stock - v_qty where id = v_product.id;
    v_subtotal := v_subtotal + v_product.price * v_qty;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    v_gst_amount := v_gst_amount + round((v_product.price::numeric * v_qty * v_tax_rate) / (100 + v_tax_rate))::integer;
    v_count := v_count + 1;
  end loop;
  if v_count <> jsonb_array_length(p_items) then raise exception 'Invalid product list'; end if;
  v_shipping := case when v_subtotal >= 2499 then 0 else 99 end;
  v_number := 'LD-' || to_char(now(),'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6));
  insert into public.store_orders(order_number,idempotency_key,customer_name,email,phone,address,city,state,pincode,subtotal,gst_amount,shipping,total,payment_status,payment_provider)
  values(v_number,p_idempotency_key,v_customer_name,v_email,v_phone,trim(p_customer->>'address'),trim(p_customer->>'city'),trim(p_customer->>'state'),trim(p_customer->>'pincode'),v_subtotal,v_gst_amount,v_shipping,v_subtotal+v_shipping,case when p_provider='cod' then 'cod' else 'pending' end,p_provider)
  returning id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    select * into v_product from public.store_products where id = v_item->>'productId';
    v_qty := (v_item->>'quantity')::integer;
    v_tax_rate := case when v_product.price <= 2500 then 5 else 18 end;
    insert into public.store_order_items(order_id,product_id,product_name,unit_price,quantity,gst_rate,gst_amount,selected_size,selected_color,image_url)
    values(v_order_id,v_product.id,v_product.name,v_product.price,v_qty,v_tax_rate,round((v_product.price::numeric * v_qty * v_tax_rate) / (100 + v_tax_rate))::integer,nullif(v_item->>'size',''),nullif(v_item->>'color',''),v_product.image_url);
  end loop;
  select * into v_order from public.store_orders where id=v_order_id;
  return jsonb_build_object('id',v_order.id,'order_number',v_order.order_number,'subtotal',v_order.subtotal,'gst_amount',v_order.gst_amount,'total',v_order.total,'shipping',v_order.shipping,'payment_status',v_order.payment_status,'payment_provider',v_order.payment_provider);
end;
$$;

revoke all on function public.create_checkout_order(jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.create_checkout_order(jsonb,jsonb,text,text) to service_role;
