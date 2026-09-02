-- Whiff shared observation log.
-- Paste the whole file into the Supabase SQL editor and run it once.
--
-- Security model: the browser holds the anon key, which is public by design.
-- These policies let anon WRITE its own reports and READ NOTHING. Without a
-- select policy, PostgREST returns zero rows to anon no matter what it asks
-- for, so a scraper with the key still cannot enumerate who reported what.
-- You read the data with the service_role key from your own machine.

create table if not exists public.observations (
  id            bigint generated always as identity primary key,

  -- Anonymous per-browser id. Not an account, not linked to a person.
  install_id    uuid        not null,
  night         date        not null,
  submitted_at  timestamptz not null default now(),

  -- The observation.
  smell         smallint    not null check (smell between 0 and 3),   -- 0 none .. 3 strong
  smell_window  text        check (smell_window in ('evening','late','predawn','allnight')),

  -- Coarsened location. Never a street address: distance in 0.25 km buckets,
  -- bearing in 10 degree buckets, elevation in 10 m buckets.
  dist_km       numeric(5,2) not null check (dist_km >= 0 and dist_km < 100),
  bearing_deg   smallint     not null check (bearing_deg between 0 and 359),
  elevation_m   smallint,

  -- What the model predicted and the factors behind it, captured at report
  -- time so calibration never has to re-fetch historical weather.
  predicted     numeric(4,3) not null check (predicted between 0 and 1),
  peak_hour     smallint     check (peak_hour between 0 and 23),
  wind_dir      smallint,
  wind_speed    numeric(4,1),
  alignment     numeric(4,3),
  stability     numeric(4,3),
  moisture      numeric(4,3),
  decoupled     numeric(4,3),
  model_version text        not null,

  -- Reject obvious junk: nobody can report a night that has not happened.
  constraint night_not_future check (night <= (now() at time zone 'America/Los_Angeles')::date),

  -- One report per browser per night; a re-report corrects the earlier one.
  constraint one_per_install_per_night unique (install_id, night)
);

create index if not exists observations_night_idx on public.observations (night);

-- Removal requests. Anon cannot delete rows (that would let anyone who learns
-- an install_id erase someone's history), so removal is a request you action.
create table if not exists public.removal_requests (
  id           bigint generated always as identity primary key,
  install_id   uuid        not null,
  requested_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.observations     enable row level security;
alter table public.removal_requests enable row level security;

drop policy if exists "anon inserts observations" on public.observations;
create policy "anon inserts observations"
  on public.observations for insert to anon with check (true);

-- Needed for the upsert that lets someone correct tonight's answer. Combined
-- with no select policy, an attacker would have to guess a random UUID *and*
-- the exact night to overwrite one row, and would learn nothing by doing it.
drop policy if exists "anon corrects observations" on public.observations;
create policy "anon corrects observations"
  on public.observations for update to anon using (true) with check (true);

drop policy if exists "anon requests removal" on public.removal_requests;
create policy "anon requests removal"
  on public.removal_requests for insert to anon with check (true);

-- Deliberately absent: any select, delete, or truncate policy for anon.

-- ---------------------------------------------------------------------------
-- Maintainer helper: process removal requests
-- ---------------------------------------------------------------------------
-- Run from the SQL editor when a request comes in.
--
--   delete from public.observations o
--    using public.removal_requests r
--    where o.install_id = r.install_id;
--   delete from public.removal_requests;

-- ---------------------------------------------------------------------------
-- Maintainer helper: is the dataset worth fitting yet?
-- ---------------------------------------------------------------------------
-- Reliability by forecast bucket. Needs both smelly AND clean nights before it
-- means anything; a column of all-positives cannot calibrate a model.
--
--   select width_bucket(predicted, 0, 1, 5) * 20 - 10 as forecast_pct,
--          count(*)                                   as nights,
--          round(avg((smell >= 1)::int) * 100)        as observed_pct
--     from public.observations
--    group by 1 order by 1;
