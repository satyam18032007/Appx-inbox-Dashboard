-- Run this entire script ONCE in Supabase -> SQL Editor -> New Query -> Run

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
  created_at timestamptz default now()
);

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
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, phone)
);

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

create index if not exists idx_leads_user_updated on public.leads (user_id, updated_at desc);
create index if not exists idx_messages_lead_created on public.messages (lead_id, created_at asc);
