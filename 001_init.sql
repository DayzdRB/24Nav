-- ============================================================================
-- 24Nav 001_init
-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Access model: the browser never talks to Supabase. Every read and write goes
-- through a Vercel Function holding SUPABASE_SECRET_KEY, which bypasses RLS.
-- RLS is therefore enabled with no permissive policies, so anon and authenticated
-- keys can reach nothing even if one leaks into client code.
-- ============================================================================

create extension if not exists "pgcrypto";

-- --- pilots ----------------------------------------------------------------
-- One row per Discord account. discord_id is the identity the signed session
-- cookie carries, so it is the natural key everything else hangs off.

create table if not exists public.profiles (
  id               uuid primary key default gen_random_uuid(),
  discord_id       text not null unique,
  discord_username text,
  display_name     text,
  avatar_url       text,
  roblox_username  text,
  public_slug      text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_seen_at     timestamptz
);

-- --- saved routes ----------------------------------------------------------
-- fixes holds the ordered route with any altitude constraints, matching the
-- client model exactly: [{"name":"ZESTA","altitude":9000}, ...]

create table if not exists public.flight_plans (
  id               uuid primary key default gen_random_uuid(),
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  title            text,
  departure        text not null,
  arrival          text not null,
  fixes            jsonb not null default '[]'::jsonb,
  route_string     text not null default 'DCT',
  cruise_fl        integer not null default 100,
  aircraft         text,
  flight_rules     text not null default 'IFR',
  -- The callsign the pilot files in the /createflightplan command.
  filed_callsign   text,
  -- The aircraft's actual in-game callsign, taken from realcallsign on the
  -- FLIGHT_PLAN event. This is the only value that joins to the position feed.
  ingame_callsign  text,
  departure_runway text,
  arrival_runway   text,
  distance_nm      numeric(8, 2) not null default 0,
  status           text not null default 'draft'
                     check (status in ('draft', 'filed', 'flown', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists flight_plans_profile_idx
  on public.flight_plans (profile_id, updated_at desc);
create index if not exists flight_plans_ingame_callsign_idx
  on public.flight_plans (ingame_callsign)
  where ingame_callsign is not null;

-- --- automatic flight log --------------------------------------------------
-- Written by the relay, not the browser. verified is false when no FLIGHT_PLAN
-- event supplied a realcallsign and the match fell back to the raw feed key.

create table if not exists public.flight_logs (
  id                 uuid primary key default gen_random_uuid(),
  profile_id         uuid references public.profiles(id) on delete set null,
  plan_id            uuid references public.flight_plans(id) on delete set null,
  filed_callsign     text,
  ingame_callsign    text,
  -- Sourced from the 24data feed, so it falls under the 14-day retention rule.
  -- purge_feed_identifiers() clears it once the log is older than that.
  feed_roblox_name   text,
  aircraft_type      text,
  departure          text,
  arrival            text,
  diverted_to        text,
  lifecycle_status   text not null default 'awaiting_departure'
                       check (lifecycle_status in (
                         'awaiting_departure', 'departed', 'on_route',
                         'signal_lost', 'landed', 'diverted', 'lost'
                       )),
  verified           boolean not null default false,
  departed_at        timestamptz,
  landed_at          timestamptz,
  distance_nm        numeric(8, 2) not null default 0,
  max_altitude_ft    integer not null default 0,
  max_speed_kt       integer not null default 0,
  overspeed_events   integer not null default 0,
  last_seen_at       timestamptz,
  last_position_x    numeric(12, 3),
  last_position_y    numeric(12, 3),
  stationary_since   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists flight_logs_profile_idx
  on public.flight_logs (profile_id, created_at desc);
create index if not exists flight_logs_active_idx
  on public.flight_logs (lifecycle_status)
  where lifecycle_status not in ('landed', 'diverted', 'lost');

-- --- lifecycle trail ------------------------------------------------------

create table if not exists public.flight_log_events (
  id          bigserial primary key,
  log_id      uuid not null references public.flight_logs(id) on delete cascade,
  event       text not null,
  altitude_ft integer,
  speed_kt    integer,
  position_x  numeric(12, 3),
  position_y  numeric(12, 3),
  airport     text,
  details     jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);

create index if not exists flight_log_events_log_idx
  on public.flight_log_events (log_id, at);

-- --- ATIS cache -----------------------------------------------------------
-- The relay owns this table. layers holds the parsed cloud decks the vertical
-- profile draws: [{"cover":"OVC","baseFt":2500,"topFt":4500}]

create table if not exists public.atis_snapshots (
  airport     text primary key,
  letter      text,
  content     text,
  layers      jsonb not null default '[]'::jsonb,
  ceiling_ft  integer,
  wind        text,
  dep_runways text[],
  arr_runways text[],
  -- Feed-sourced identifier, cleared by purge_feed_identifiers().
  editor      text,
  received_at timestamptz not null default now()
);

-- --- 24data retention -----------------------------------------------------
-- The 24data terms cap retention of identifiable API data at 14 days. Flight
-- logs stay, the feed-sourced usernames on them do not.

create or replace function public.purge_feed_identifiers()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  touched integer := 0;
begin
  update public.flight_logs
     set feed_roblox_name = null,
         updated_at = now()
   where feed_roblox_name is not null
     and created_at < now() - interval '14 days';
  get diagnostics touched = row_count;

  update public.atis_snapshots
     set editor = null
   where editor is not null
     and received_at < now() - interval '14 days';

  delete from public.flight_log_events
   where at < now() - interval '90 days';

  return touched;
end;
$$;

-- --- updated_at -----------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists flight_plans_touch on public.flight_plans;
create trigger flight_plans_touch before update on public.flight_plans
  for each row execute function public.touch_updated_at();

drop trigger if exists flight_logs_touch on public.flight_logs;
create trigger flight_logs_touch before update on public.flight_logs
  for each row execute function public.touch_updated_at();

-- --- lock the front door --------------------------------------------------

alter table public.profiles          enable row level security;
alter table public.flight_plans      enable row level security;
alter table public.flight_logs       enable row level security;
alter table public.flight_log_events enable row level security;
alter table public.atis_snapshots    enable row level security;

revoke all on public.profiles          from anon, authenticated;
revoke all on public.flight_plans      from anon, authenticated;
revoke all on public.flight_logs       from anon, authenticated;
revoke all on public.flight_log_events from anon, authenticated;
revoke all on public.atis_snapshots    from anon, authenticated;
