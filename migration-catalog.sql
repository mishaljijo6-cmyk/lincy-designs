-- Expand the catalog category and replace the launch demo catalog with apparel.
alter table public.store_products drop constraint if exists store_products_category_check;
alter table public.store_products add constraint store_products_category_check
  check (category in ('Churidars','Kurtas'));

update public.store_products as product
set name = catalog.name,
    category = catalog.category,
    price = catalog.price,
    compare_at = catalog.compare_at,
    badge = catalog.badge,
    sizes = catalog.sizes,
    colors = catalog.colors,
    description = catalog.description,
    updated_at = now()
from (values
  ('tt-001','Garden Bloom Anarkali Churidar Set','Churidars',3290,3890,'NEW ARRIVAL',array['S','M','L','XL','XXL']::text[],array['Sage','Rose']::text[],'A softly flared Anarkali set in a botanical print, with an easy drape and thoughtful finishing. Includes kurta, churidar bottom and dupatta.'),
  ('tt-002','Ivory Festive Churidar Suit','Churidars',3490,3990,'FESTIVE EDIT',array['S','M','L','XL','XXL']::text[],array['Ivory','Gold']::text[],'A graceful festive suit with delicate woven-look details, a comfortable churidar bottom and a coordinating dupatta.'),
  ('tt-003','Mullapoo Embroidered Kurta','Kurtas',1890,2290,'BESTSELLER',array['S','M','L','XL','XXL']::text[],array['Blush','Ivory']::text[],'A delicate floral kurta with gentle embroidery and a relaxed fit. An easy favourite for workdays and family visits.'),
  ('tt-004','Soft Sage Straight-Cut Churidar Set','Churidars',2790,0,'LIMITED EDITION',array['S','M','L','XL']::text[],array['Sage','Cream']::text[],'A versatile straight-cut kurta paired with a matching churidar and a light dupatta for effortless all-day comfort.'),
  ('tt-005','Rose Print Everyday Kurta','Kurtas',1490,1790,'EASY COTTON',array['S','M','L','XL','XXL']::text[],array['Terracotta','Indigo']::text[],'Soft breathable cotton, a beautiful print, and an easy everyday fit. Made for comfort from morning chai to evening plans.'),
  ('tt-006','Maroon Embroidered Churidar Set','Churidars',3990,4490,'FEW LEFT',array['S','M','L','XL','XXL']::text[],array['Maroon','Gold']::text[],'A rich occasion-ready set with graceful embroidery, a flattering kurta, comfortable churidar and a coordinating dupatta.'),
  ('tt-007','Everyday Straight Kurta','Kurtas',1290,1590,'EVERYDAY FAVOURITE',array['S','M','L','XL','XXL']::text[],array['Ivory','Sage']::text[],'A simple, easy-to-style kurta with a relaxed silhouette and soft feel for everyday wear.'),
  ('tt-008','Textured Cotton Kurta','Kurtas',2190,0,'SMALL BATCH',array['S','M','L','XL']::text[],array['Ivory','Forest']::text[],'A crisp cotton-blend kurta with understated texture and a relaxed silhouette, finished for comfort.')
) as catalog(id,name,category,price,compare_at,badge,sizes,colors,description)
where product.id = catalog.id;
