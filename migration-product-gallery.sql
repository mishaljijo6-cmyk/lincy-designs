-- Add a product gallery and per-colour photo sets for the storefront and admin editor.
alter table public.store_products
  add column if not exists image_gallery text[] not null default '{}',
  add column if not exists color_images jsonb not null default '{}'::jsonb;

comment on column public.store_products.image_gallery is 'Additional product photos shared across variants';
comment on column public.store_products.color_images is 'JSON object mapping each color name to an array of photo URLs';
