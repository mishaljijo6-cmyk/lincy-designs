create table if not exists public.newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (length(email) between 5 and 254),
  created_at timestamptz not null default now()
);

alter table public.newsletter_subscribers enable row level security;
