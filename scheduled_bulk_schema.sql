-- Scheduled campaigns. Only the server's service role can access the queue or worker token.
create table if not exists public.scheduled_bulk_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  campaign_name text not null,
  scheduled_at timestamptz not null,
  started_at timestamptz,
  status text not null default 'queued'
    check (status in ('queued','running','completed','completed_with_errors','failed','cancelled','needs_review')),
  payload jsonb,
  result jsonb
);
create index if not exists idx_scheduled_bulk_due on public.scheduled_bulk_campaigns (scheduled_at) where status = 'queued';
create index if not exists idx_scheduled_bulk_user on public.scheduled_bulk_campaigns (user_id, scheduled_at desc);
create table if not exists public.scheduled_bulk_worker_secret (
  id boolean primary key default true check (id),
  token text not null
);
alter table public.scheduled_bulk_campaigns enable row level security;
alter table public.scheduled_bulk_worker_secret enable row level security;
revoke all on public.scheduled_bulk_campaigns, public.scheduled_bulk_worker_secret from public, anon, authenticated;
grant select, insert, update on public.scheduled_bulk_campaigns to service_role;
grant select on public.scheduled_bulk_worker_secret to service_role;
insert into public.scheduled_bulk_worker_secret (id, token)
values (true, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (id) do nothing;
