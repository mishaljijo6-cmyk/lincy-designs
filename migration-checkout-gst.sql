-- Legacy compatibility migration: this file only adds persisted GST columns.
-- The single supported checkout implementation is in migration-orders-and-checkout.sql.
-- Run that migration after this one; do not use this file to replace checkout logic.
alter table public.store_orders
  add column if not exists gst_amount integer not null default 0;
alter table public.store_order_items
  add column if not exists gst_rate integer not null default 0,
  add column if not exists gst_amount integer not null default 0;
