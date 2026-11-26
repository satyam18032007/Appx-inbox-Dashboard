-- Run this entire script in Supabase -> SQL Editor -> New Query -> Run
-- Safe to re-run on existing projects (uses IF NOT EXISTS everywhere)

create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  whatsapp_token text default '',
  phone_number_id text default '',
  verify_token text not null,
  graph_version text default 'v21.0',
  connected_phone text default '',
  gemini_api_key text default '',
  ai_enabled boolean default false,
  ai_max_questions integer default 3,
  ai_system_prompt text default '',
  owner_alert_phone text default '',
  fast2sms_api_key text default '',
  created_at timestamptz default now()
);

-- Safe column upgrades for existing users table
alter table public.users add column if not exists waba_id text default '';
alter table public.users add column if not exists gemini_api_key text default '';
alter table public.users add column if not exists ai_enabled boolean default false;
alter table public.users add column if not exists ai_max_questions integer default 3;
alter table public.users add column if not exists ai_system_prompt text default '';
alter table public.users add column if not exists owner_alert_phone text default '';
alter table public.users add column if not exists fast2sms_api_key text default '';

create table if not exists public.sessions (
  token text primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz default now()
);

create table if not exists public.leads (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  phone text not null,
  business_name text default '',
  campaign_name text default 'appx (Marketing)',
  reply_type text default 'No response',
  ticket_state text default 'Pending',
  status text default 'No Response',
  has_responded boolean default false,
  demo_date text default '',
  followup_date text default '',
  deal_value integer default 0,
  notes text default '',
  last_message text default '',
  last_incoming_at timestamptz,
  unread_count integer default 0,
  ai_paused boolean default false,
  ai_stage text default 'qualifying',
  ai_questions_asked integer default 0,
  detected_category text default '',
  assets_sent boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, phone)
);

alter table public.leads add column if not exists ai_paused boolean default false;
alter table public.leads add column if not exists ai_stage text default 'qualifying';
alter table public.leads add column if not exists ai_questions_asked integer default 0;
alter table public.leads add column if not exists detected_category text default '';
alter table public.leads add column if not exists assets_sent boolean default false;

create table if not exists public.messages (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  lead_id bigint not null references public.leads(id) on delete cascade,
  direction text not null check (direction in ('incoming', 'outgoing')),
  body text not null,
  wa_message_id text default '',
  delivery_status text default 'sent',
  created_at timestamptz default now()
);

-- Category-based Brochure / Asset / Voucher Kits for AI Sales Agent
create table if not exists public.asset_kits (
  id bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  category_name text not null,
  keywords text default '',
  message_text text default '',
  asset_url text default '',
  asset_type text default 'document',
  created_at timestamptz default now()
);

create index if not exists idx_leads_user_updated on public.leads (user_id, updated_at desc);
create index if not exists idx_messages_lead_created on public.messages (lead_id, created_at asc);
create index if not exists idx_assets_user on public.asset_kits (user_id);

-- AppX team memberships and expiring invitations. Only the backend service role uses this table.
create table if not exists public.team_access (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users(id) on delete cascade,
  member_id uuid references public.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('operator', 'viewer')),
  invite_hash text unique,
  expires_at timestamptz,
  unique (owner_id, email),
  unique (owner_id, member_id),
  check (member_id is distinct from owner_id),
  check ((member_id is null and invite_hash is not null and expires_at is not null)
    or (member_id is not null and invite_hash is null and expires_at is null))
);
alter table public.team_access enable row level security;
revoke all on public.team_access from anon, authenticated;
grant select, insert, update, delete on public.team_access to service_role;

-- Access to business data goes through the AppX server.
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.leads enable row level security;
alter table public.messages enable row level security;
alter table public.asset_kits enable row level security;

-- Webhook signing and distributed authentication request limits.
alter table public.users add column if not exists meta_app_secret text default '';

create table if not exists public.appx_auth_limits (
  key text primary key,
  window_start timestamptz not null,
  attempts integer not null
);
alter table public.appx_auth_limits enable row level security;
revoke all on public.appx_auth_limits from anon, authenticated;
grant select, insert, update, delete on public.appx_auth_limits to service_role;

create or replace function public.appx_allow_auth_request(p_key text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_window timestamptz := date_bin(interval '10 minutes', now(), '2000-01-01 00:00:00+00'::timestamptz);
  current_attempts integer;
begin
  if random() < 0.01 then
    delete from public.appx_auth_limits where window_start < current_window - interval '1 day';
  end if;
  insert into public.appx_auth_limits(key, window_start, attempts)
  values (p_key, current_window, 1)
  on conflict (key) do update
    set attempts = case
      when appx_auth_limits.window_start = excluded.window_start then least(appx_auth_limits.attempts + 1, 31)
      else 1
    end,
    window_start = excluded.window_start
  returning attempts into current_attempts;
  return current_attempts <= 30;
end;
$$;
revoke execute on function public.appx_allow_auth_request(text) from public, anon, authenticated;
grant execute on function public.appx_allow_auth_request(text) to service_role;

-- Preserve Meta audio IDs for authorized Inbox playback.
alter table public.messages add column if not exists audio_media_id text;


-- WhatsApp may deliver an incoming message more than once.
begin;
lock table public.messages in share row exclusive mode;
with duplicates as (
  select id, row_number() over (
    partition by user_id, wa_message_id order by created_at asc nulls last, id asc
  ) as occurrence
  from public.messages
  where direction = 'incoming' and wa_message_id <> ''
)
delete from public.messages
using duplicates
where messages.id = duplicates.id and duplicates.occurrence > 1;

create unique index if not exists idx_messages_unique_incoming_whatsapp_id
  on public.messages (user_id, wa_message_id)
  where direction = 'incoming' and wa_message_id <> '';
commit;
